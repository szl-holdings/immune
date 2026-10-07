import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalBytes, sha256Hex } from "./canonical";
import { isDeclaredLocalFilesystemCandidate } from "./storage-policy";

export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";
export type EvidenceState = "VERIFIED" | "FAILED" | "UNAVAILABLE" | "STALE";

export const ACTION_ENVELOPE_VERSION = "immune.action.v2" as const;
export const ACTION_AUDIENCE = "hf-space:SZLHOLDINGS/immune" as const;
export const ACTION_SOURCE_REPOSITORY = "szl-holdings/immune" as const;
export const ACTION_DEPLOYMENT_SPACE = "SZLHOLDINGS/immune" as const;
export const MAX_AUTHORITY_LEASE_MS = 24 * 60 * 60_000;
export const MAX_PASS_AUTHORITY_LEASE_MS = 15 * 60_000;
const DEFAULT_MAX_EVIDENCE_AGE_MS = MAX_AUTHORITY_LEASE_MS;
const MAX_ACTION_SUBMISSION_LIFETIME_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const AUTHORITY_INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TRUST_EPOCH_PATTERN = /^[a-f0-9]{32}$/;

const SetModeActionSchema = z
  .object({
    type: z.literal("SET_MODE"),
    mode: z.enum(["PASS", "SENTRA_REJECT", "DEADMAN"]),
    tripwire: z
      .enum(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"])
      .nullable()
      .optional(),
  })
  .strict();
const ResetActionSchema = z.object({ type: z.literal("RESET") }).strict();

export const SignedActionEnvelopeSchema = z
  .object({
    version: z.literal(ACTION_ENVELOPE_VERSION),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    trustEpoch: z.string().regex(TRUST_EPOCH_PATTERN),
    authorityInstanceId: z.string().regex(AUTHORITY_INSTANCE_ID_PATTERN),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedReceiptHash: z.union([z.literal("GENESIS"), z.string().regex(RECEIPT_HASH_PATTERN)]),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    actor: z.string().min(3).max(256),
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    audience: z.literal(ACTION_AUDIENCE),
    source: z
      .object({
        repository: z.literal(ACTION_SOURCE_REPOSITORY),
        revision: z.string().regex(SOURCE_REVISION_PATTERN),
      })
      .strict(),
    deployment: z
      .object({
        space: z.literal(ACTION_DEPLOYMENT_SPACE),
        revision: z.string().regex(SOURCE_REVISION_PATTERN),
      })
      .strict(),
    action: z.discriminatedUnion("type", [SetModeActionSchema, ResetActionSchema]),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]{86}==$/)
      .refine((value) => {
        const decoded = Buffer.from(value, "base64");
        return decoded.length === 64 && decoded.toString("base64") === value;
      }, "signature must be canonical base64 for exactly 64 bytes"),
  })
  .strict()
  .superRefine((envelope, context) => {
    const genesis = envelope.expectedReceiptHash === "GENESIS";
    if ((envelope.expectedRevision === 0) !== genesis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedReceiptHash"],
        message: "GENESIS is required exactly when expectedRevision is zero",
      });
    }
  });

export type SignedActionEnvelope = z.infer<typeof SignedActionEnvelopeSchema>;
type Action = SignedActionEnvelope["action"];

export interface StoredState {
  mode: ImmuneMode;
  tripwire: string | null;
  deadman: boolean;
  updatedAt: string | null;
  requestId: string | null;
  revision: number;
}

export interface AuthoritySnapshot extends StoredState {
  evidenceState: EvidenceState;
  reason: string;
  validUntil: string | null;
  authorityReceiptCount: number;
  authorityReceiptHash: string | null;
  authority: {
    enabled: boolean;
    version: typeof ACTION_ENVELOPE_VERSION;
    keyId: string | null;
    trustEpoch: string | null;
    instanceId: string | null;
    audience: typeof ACTION_AUDIENCE;
    source: {
      repository: typeof ACTION_SOURCE_REPOSITORY;
      revision: string | null;
    };
    deployment: {
      space: typeof ACTION_DEPLOYMENT_SPACE;
      revision: string | null;
    };
    durability: {
      required: boolean;
      verified: boolean;
      path: string;
    };
    externalOperator: true;
  };
}

export interface AuthoritativeTripwireState {
  evidenceState: EvidenceState;
  mode: ImmuneMode;
  deadman: boolean;
  tripwire: string | null;
  reason: string;
  validUntil: string | null;
  updatedAt: string | null;
  requestId: string | null;
  revision: number;
}

/**
 * The single effective authority projection used by execution and every public
 * operator surface. Durable state remains observable, but it cannot become an
 * active tripwire or PASS claim unless its signed evidence is freshly VERIFIED.
 */
export function authoritativeTripwireState(
  snapshot: AuthoritySnapshot,
): AuthoritativeTripwireState {
  const verified = snapshot.evidenceState === "VERIFIED";
  const consistent =
    !verified ||
    (snapshot.mode === "DEADMAN"
      ? snapshot.deadman && snapshot.tripwire !== null
      : !snapshot.deadman && snapshot.tripwire === null);
  if (!consistent) {
    return {
      evidenceState: "FAILED",
      mode: "SENTRA_REJECT",
      deadman: false,
      tripwire: null,
      reason: "verified authority state contains an inconsistent tripwire binding",
      validUntil: snapshot.validUntil,
      updatedAt: snapshot.updatedAt,
      requestId: snapshot.requestId,
      revision: snapshot.revision,
    };
  }
  const deadman = verified && snapshot.mode === "DEADMAN" && snapshot.deadman;
  return {
    evidenceState: snapshot.evidenceState,
    mode: verified ? snapshot.mode : "SENTRA_REJECT",
    deadman,
    tripwire: deadman ? snapshot.tripwire : null,
    reason: snapshot.reason,
    validUntil: snapshot.validUntil,
    updatedAt: snapshot.updatedAt,
    requestId: snapshot.requestId,
    revision: snapshot.revision,
  };
}

export type PublicAuthoritySnapshot = AuthoritySnapshot & {
  durableState: StoredState;
  tripwireState: AuthoritativeTripwireState;
};

/**
 * Preserve durable state for audit under an explicit namespace while keeping
 * legacy top-level fields fail-closed and identical to tripwireState.
 */
export function publicAuthoritySnapshot(
  snapshot: AuthoritySnapshot,
): PublicAuthoritySnapshot {
  const tripwireState = authoritativeTripwireState(snapshot);
  const durableState: StoredState = {
    mode: snapshot.mode,
    tripwire: snapshot.tripwire,
    deadman: snapshot.deadman,
    updatedAt: snapshot.updatedAt,
    requestId: snapshot.requestId,
    revision: snapshot.revision,
  };
  return {
    ...snapshot,
    evidenceState: tripwireState.evidenceState,
    mode: tripwireState.mode,
    deadman: tripwireState.deadman,
    tripwire: tripwireState.tripwire,
    reason: tripwireState.reason,
    validUntil: tripwireState.validUntil,
    durableState,
    tripwireState,
  };
}

export interface AuthorityReceipt {
  seq: number;
  requestId: string;
  envelopeDigest: string;
  previousHash: string;
  receiptHash: string;
  issuedAt: string;
  appliedAt: string;
  actor: string;
  action: Action;
  result: StoredState;
  envelope: SignedActionEnvelope;
}

export class AuthorityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthorityError";
  }
}

export interface AuthorityStoreOptions {
  databasePath: string;
  publicKeyB64?: string | null;
  sourceRevision?: string | null;
  deploymentRevision: string;
  trustEpoch?: string | null;
  maxEvidenceAgeMs?: number;
  now?: () => Date;
  requireDurableStorage?: boolean;
  /** Test-only observation override; rejected in production and the canonical Space. */
  durabilityCheck?: (databasePath: string, phase: AuthorityStoragePhase) => boolean;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalBytes(left).equals(canonicalBytes(right));
  } catch {
    return false;
  }
}

function parsePublicKey(publicKeyB64: string | null | undefined): {
  key: crypto.KeyObject;
  keyId: string;
} | null {
  if (!publicKeyB64) return null;
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== publicKeyB64) {
    throw new AuthorityError(
      "INVALID_TRUST_ROOT",
      "IMMUNE_ACTION_PUBLIC_KEY must be canonical base64 for one raw Ed25519 public key",
      503,
    );
  }
  const keyId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return { key, keyId };
}

function unsignedEnvelope(envelope: SignedActionEnvelope): Omit<SignedActionEnvelope, "signature"> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

export function actionEnvelopeBytes(
  envelope: Omit<SignedActionEnvelope, "signature">,
): Buffer {
  return canonicalBytes(envelope);
}

function safeState(): StoredState {
  return {
    mode: "SENTRA_REJECT",
    tripwire: null,
    deadman: false,
    updatedAt: null,
    requestId: null,
    revision: 0,
  };
}

function stateForAction(
  action: Action,
  issuedAt: string,
  requestId: string,
  revision: number,
): StoredState {
  if (action.type === "RESET") {
    return {
      mode: "PASS",
      tripwire: null,
      deadman: false,
      updatedAt: issuedAt,
      requestId,
      revision,
    };
  }
  return {
    mode: action.mode,
    tripwire: action.mode === "DEADMAN" ? action.tripwire ?? null : null,
    deadman: action.mode === "DEADMAN",
    updatedAt: issuedAt,
    requestId,
    revision,
  };
}

function asStoredState(row: Record<string, unknown>): StoredState {
  return {
    mode: row.mode as ImmuneMode,
    tripwire: (row.tripwire as string | null) ?? null,
    deadman: Number(row.deadman) === 1,
    updatedAt: (row.updated_at as string | null) ?? null,
    requestId: (row.last_request_id as string | null) ?? null,
    revision: Number(row.revision),
  };
}

function receiptHashInput(receipt: Omit<AuthorityReceipt, "receiptHash" | "envelope">): Record<string, unknown> {
  return {
    seq: receipt.seq,
    requestId: receipt.requestId,
    envelopeDigest: receipt.envelopeDigest,
    previousHash: receipt.previousHash,
    issuedAt: receipt.issuedAt,
    appliedAt: receipt.appliedAt,
    actor: receipt.actor,
    action: receipt.action,
    result: receipt.result,
  };
}

export type AuthorityStoragePhase = "preopen" | "opened" | "snapshot" | "admission" | "locked" | "precommit";

type StorageStat = Pick<fs.Stats,
  "dev" | "ino" | "isDirectory" | "isFile" | "isSymbolicLink">;
type FileIdentity = { dev: number; ino: number };

export interface AuthorityStorageFileSystem {
  readMountInfo(): string;
  lstat(file: string): StorageStat;
  realpath(file: string): string;
  access(file: string): void;
}

export interface AuthorityStorageObservation {
  available: boolean;
  mountId: string | null;
  data: FileIdentity | null;
  directory: FileIdentity | null;
  database: FileIdentity | null;
  wal: FileIdentity | null;
  shm: FileIdentity | null;
  reason: string;
}

const AUTHORITY_STORAGE_FILESYSTEM: AuthorityStorageFileSystem = {
  readMountInfo: () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
  lstat: (file) => fs.lstatSync(file),
  realpath: (file) => fs.realpathSync(file),
  access: (file) => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK),
};

function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

/** An opened SQLite handle must remain bound to the files observed at bootstrap. */
export function authorityStorageBindingMatches(
  previous: AuthorityStorageObservation,
  current: AuthorityStorageObservation,
  bootstrap = false,
): boolean {
  if (!previous.available || !current.available || !previous.mountId ||
      previous.mountId !== current.mountId || !sameFile(previous.data, current.data)) return false;
  return (["directory", "database", "wal", "shm"] as const).every((field) =>
    bootstrap && previous[field] === null
      ? current[field] !== null
      : sameFile(previous[field], current[field]),
  );
}

/**
 * Metadata-only observation, not fsync or restart proof. Never independently open
 * and close DB/WAL/SHM files here: POSIX close can release SQLite's process-wide
 * advisory locks, including during an active BEGIN IMMEDIATE transaction.
 * SQLite owns all database descriptors and transaction synchronization.
 */
export function observeAuthorityStorage(databasePath: string, options: {
  preopen?: boolean;
  fileSystem?: AuthorityStorageFileSystem;
} = {}): AuthorityStorageObservation {
  const unavailable = (reason: string): AuthorityStorageObservation => ({
    available: false, mountId: null, data: null, directory: null, database: null, wal: null, shm: null, reason,
  });
  if (!/^\/data\/immune\/[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/u.test(databasePath)) {
    return unavailable("authority database path must be canonical under /data/immune");
  }
  const io = options.fileSystem ?? AUTHORITY_STORAGE_FILESYSTEM;
  const preopen = options.preopen === true;
  try {
    const mountInfo = io.readMountInfo();
    const mounts = mountInfo.split(/\r?\n/u).filter(Boolean).map((line) => {
      const parts = line.split(" - ");
      if (parts.length !== 2) throw new Error("malformed mount observation");
      const fields = parts[0].split(" ");
      const filesystem = parts[1].split(" ");
      if (fields.length < 6 || filesystem.length < 3 ||
          !/^\d+$/u.test(fields[0]) || !/^\d+$/u.test(fields[1]) ||
          !/^\d+:\d+$/u.test(fields[2])) throw new Error("malformed mount observation");
      return {
        id: fields[0],
        point: fields[4].replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8))),
        options: fields[5].split(","),
        filesystem: filesystem[0],
        superOptions: filesystem[2].split(","),
      };
    });
    if (new Set(mounts.map(({ id }) => id)).size !== mounts.length) {
      return unavailable("mount identity is ambiguous");
    }
    const dataMounts = mounts.filter(({ point }) => point === "/data");
    if (dataMounts.length !== 1) return unavailable("exact /data mount is absent or ambiguous");
    const dataMount = dataMounts[0];
    if (!dataMount.options.includes("rw") || dataMount.options.includes("ro") ||
        !dataMount.superOptions.includes("rw") || dataMount.superOptions.includes("ro") ||
        !isDeclaredLocalFilesystemCandidate(dataMount.filesystem)) {
      return unavailable("/data is not a writable declared filesystem candidate");
    }
    const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    for (const target of ["/data/immune", ...files]) {
      const covering = mounts.filter(({ point }) =>
        target === point || target.startsWith(`${point}/`),
      ).sort((left, right) => right.point.length - left.point.length);
      if (covering[0]?.id !== dataMount.id) return unavailable("authority path has a nested or different mount");
    }
    const maybeStat = (file: string): StorageStat | null => {
      try { return io.lstat(file); } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    };
    const identity = (stat: StorageStat): FileIdentity => {
      if (!Number.isSafeInteger(stat.dev) || stat.dev < 0 ||
          !Number.isSafeInteger(stat.ino) || stat.ino < 0) throw new Error("invalid filesystem identity");
      return { dev: stat.dev, ino: stat.ino };
    };
    const data = io.lstat("/data");
    if (!data.isDirectory() || data.isSymbolicLink() || io.realpath("/data") !== "/data") {
      return unavailable("/data is not a canonical directory");
    }
    const dataIdentity = identity(data);
    io.access("/data");
    const directory = maybeStat("/data/immune");
    if (!directory) {
      if (!preopen || files.some((file) => maybeStat(file) !== null)) {
        return unavailable("authority directory is absent or has orphaned files");
      }
      if (!sameFile(dataIdentity, identity(io.lstat("/data"))) || io.readMountInfo() !== mountInfo) {
        return unavailable("authority mount changed during bootstrap observation");
      }
      return {
        available: true, mountId: dataMount.id, data: dataIdentity, directory: null, database: null, wal: null, shm: null,
        reason: "verified fresh /data mount permits directory and database bootstrap; no authority exists",
      };
    }
    const directoryIdentity = identity(directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        directoryIdentity.dev !== dataIdentity.dev || io.realpath("/data/immune") !== "/data/immune") {
      return unavailable("authority directory is symlinked or outside /data");
    }
    io.access("/data/immune");
    const identities: Array<FileIdentity | null> = [];
    for (const file of files) {
      const observed = maybeStat(file);
      if (!observed) {
        if (!preopen) return unavailable("an active authority database requires its database, WAL, and SHM files");
        identities.push(null);
        continue;
      }
      const before = identity(observed);
      if (!observed.isFile() || observed.isSymbolicLink() ||
          before.dev !== dataIdentity.dev || io.realpath(file) !== file) {
        return unavailable("authority database or sidecar is not a canonical regular /data file");
      }
      io.access(file);
      identities.push(before);
    }
    if (!identities[0] && (identities[1] || identities[2])) return unavailable("sidecars without a database cannot bootstrap");
    // Recheck the complete set after observing all files, so a changed earlier
    // file is not blessed merely because its first stat preceded a later one.
    for (const [index, file] of files.entries()) {
      const current = maybeStat(file);
      if (identities[index] === null) {
        if (current !== null) return unavailable("authority file appeared during bootstrap observation");
      } else if (!current || !current.isFile() || current.isSymbolicLink() ||
          !sameFile(identities[index], identity(current)) || io.realpath(file) !== file) {
        return unavailable("authority file identity changed during observation");
      } else {
        io.access(file);
      }
    }
    if (!sameFile(directoryIdentity, identity(io.lstat("/data/immune"))) ||
        io.realpath("/data/immune") !== "/data/immune") return unavailable("authority directory changed during observation");
    if (!sameFile(dataIdentity, identity(io.lstat("/data"))) ||
        io.realpath("/data") !== "/data" || io.readMountInfo() !== mountInfo) {
      return unavailable("authority mount changed during observation");
    }
    return {
      available: true, mountId: dataMount.id, data: dataIdentity, directory: directoryIdentity,
      database: identities[0], wal: identities[1], shm: identities[2],
      reason: preopen
        ? "existing files are bound to /data; absent WAL/SHM may be created or recovered only by SQLite bootstrap"
        : "database, WAL, and SHM metadata remain bound to exact /data; SQLite synchronization and restart proof are separate",
    };
  } catch {
    return unavailable("authority storage metadata observation is unavailable, raced, or inaccessible");
  }
}

export class AuthorityStore {
  private readonly db: DatabaseSync;
  private readonly trust: ReturnType<typeof parsePublicKey>;
  private readonly sourceRevision: string;
  private readonly deploymentRevision: string;
  private readonly trustEpoch: string;
  private readonly maxEvidenceAgeMs: number;
  private readonly now: () => Date;
  private readonly instanceId: string;
  private readonly durabilityRequired: boolean;
  private readonly databasePath: string;
  private readonly testDurabilityCheck: AuthorityStoreOptions["durabilityCheck"];
  private storageIdentity: AuthorityStorageObservation | null = null;
  private storageFailure: string | null = null;
  private readonly databaseDirectory: string;
  private closed = false;

  constructor(options: AuthorityStoreOptions) {
    this.trust = parsePublicKey(options.publicKeyB64);
    if (!options.sourceRevision || !SOURCE_REVISION_PATTERN.test(options.sourceRevision)) {
      throw new AuthorityError(
        "INVALID_SOURCE_BINDING",
        "IMMUNE_ACTION_SOURCE_REVISION must be the exact lowercase 40-hex deployed source revision",
        503,
      );
    }
    this.sourceRevision = options.sourceRevision;
    const declaredDeploymentRevision = options.deploymentRevision.trim().toLowerCase();
    if (!SOURCE_REVISION_PATTERN.test(declaredDeploymentRevision)) {
      throw new AuthorityError(
        "INVALID_DEPLOYMENT_BINDING",
        "HF_SPACE_REVISION must be the exact lowercase 40-hex deployed Hugging Face revision",
        503,
      );
    }
    this.deploymentRevision = declaredDeploymentRevision;
    if (!options.trustEpoch || !TRUST_EPOCH_PATTERN.test(options.trustEpoch)) {
      throw new AuthorityError(
        "INVALID_TRUST_EPOCH",
        "IMMUNE_ACTION_TRUST_EPOCH must be an exact lowercase 32-hex public trust epoch",
        503,
      );
    }
    this.trustEpoch = options.trustEpoch;
    this.maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
    if (
      !Number.isFinite(this.maxEvidenceAgeMs) ||
      this.maxEvidenceAgeMs <= 0 ||
      this.maxEvidenceAgeMs > MAX_AUTHORITY_LEASE_MS
    ) {
      throw new AuthorityError(
        "INVALID_CONFIGURATION",
        "IMMUNE_EVIDENCE_MAX_AGE_MS must be positive and no greater than the 24-hour lease cap",
        503,
      );
    }
    this.now = options.now ?? (() => new Date());
    const production = process.env.NODE_ENV === "production" || process.env.SPACE_ID === ACTION_DEPLOYMENT_SPACE;
    if (production && options.durabilityCheck !== undefined) {
      throw new AuthorityError("INVALID_CONFIGURATION", "test durability overrides are forbidden in production and the canonical Space", 503);
    }
    this.databasePath = options.databasePath;
    this.databaseDirectory = path.dirname(path.resolve(options.databasePath));
    this.durabilityRequired = production || (options.requireDurableStorage ?? false);
    this.testDurabilityCheck = options.durabilityCheck;
    this.requireStorage("preopen");
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    try {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.requireSqliteDurability();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        store_instance_id TEXT NOT NULL,
        active_key_id TEXT NOT NULL,
        trust_epoch TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authority_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('PASS', 'SENTRA_REJECT', 'DEADMAN')),
        tripwire TEXT,
        deadman INTEGER NOT NULL CHECK (deadman IN (0, 1)),
        updated_at TEXT,
        last_request_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      CREATE TRIGGER IF NOT EXISTS authority_metadata_no_update
        BEFORE UPDATE ON authority_metadata
        BEGIN SELECT RAISE(ABORT, 'authority metadata is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS authority_metadata_no_delete
        BEFORE DELETE ON authority_metadata
        BEGIN SELECT RAISE(ABORT, 'authority metadata is immutable'); END;
      INSERT OR IGNORE INTO authority_state
        (id, mode, tripwire, deadman, updated_at, last_request_id, revision)
        VALUES (1, 'SENTRA_REJECT', NULL, 0, NULL, NULL, 0);

      CREATE TABLE IF NOT EXISTS authority_receipts (
        seq INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        envelope_digest TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        receipt_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        envelope_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS authority_receipts_no_update
        BEFORE UPDATE ON authority_receipts
        BEGIN SELECT RAISE(ABORT, 'authority receipts are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS authority_receipts_no_delete
        BEFORE DELETE ON authority_receipts
        BEGIN SELECT RAISE(ABORT, 'authority receipts are append-only'); END;
    `);
    const activeKeyId = this.trust?.keyId ?? "UNCONFIGURED";
    this.db
      .prepare(`
        INSERT OR IGNORE INTO authority_metadata (id, store_instance_id, active_key_id, trust_epoch)
        VALUES (1, ?, ?, ?)
      `)
      .run(crypto.randomBytes(16).toString("hex"), activeKeyId, this.trustEpoch);
    const metadata = this.db
      .prepare("SELECT store_instance_id, active_key_id, trust_epoch FROM authority_metadata WHERE id = 1")
      .get() as { store_instance_id: string; active_key_id: string; trust_epoch: string } | undefined;
    if (!metadata || !AUTHORITY_INSTANCE_ID_PATTERN.test(metadata.store_instance_id)) {
      throw new AuthorityError("INVALID_STORE_EPOCH", "authority store instance identity is invalid", 503);
    }
    if (metadata.active_key_id !== activeKeyId) {
      throw new AuthorityError(
        "KEY_EPOCH_MISMATCH",
        "authority store belongs to a different action trust-root epoch",
        503,
      );
    }
    if (metadata.trust_epoch !== this.trustEpoch) {
      throw new AuthorityError(
        "TRUST_EPOCH_MISMATCH",
        "authority store belongs to a different public trust epoch",
        503,
      );
    }
    this.instanceId = metadata.store_instance_id;
    this.requireStorage("opened");
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the initialization failure. */ }
      this.closed = true;
      throw error;
    }
  }

  private requireSqliteDurability(): void {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    const synchronous = this.db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown } | undefined;
    if (journal?.journal_mode !== "wal" || synchronous?.synchronous !== 2) {
      throw new AuthorityError("DURABLE_AUTHORITY_STORAGE_UNAVAILABLE", "SQLite connection must retain journal_mode=WAL and synchronous=FULL", 503);
    }
  }

  private requireStorage(phase: AuthorityStoragePhase): boolean {
    if (!this.durabilityRequired) return false;
    if (this.closed) throw new AuthorityError("AUTHORITY_UNAVAILABLE", "authority store is closed", 503);
    if (!this.storageFailure) {
      try {
        if (phase !== "preopen") this.requireSqliteDurability();
        if (this.testDurabilityCheck) {
          if (this.testDurabilityCheck(this.databasePath, phase) === true) return true;
          this.storageFailure = `test storage observation failed at ${phase}`;
        } else {
          const observed = observeAuthorityStorage(this.databasePath, { preopen: phase === "preopen" });
          if (!observed.available) {
            this.storageFailure = observed.reason;
          } else if (this.storageIdentity && !authorityStorageBindingMatches(this.storageIdentity, observed, phase === "opened")) {
            this.storageFailure = "authority database, sidecar, directory, or mount identity changed";
          } else {
            this.storageIdentity = observed;
            return true;
          }
        }
      } catch {
        this.storageFailure = `authority storage observation unavailable at ${phase}`;
      }
    }
    // A changed or lost file binding cannot be repaired on an already-open SQLite handle.
    throw new AuthorityError("DURABLE_AUTHORITY_STORAGE_UNAVAILABLE", this.storageFailure, 503);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  journalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  private state(): StoredState {
    const row = this.db.prepare("SELECT * FROM authority_state WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("authority state row is missing");
    return asStoredState(row);
  }

  receipts(): AuthorityReceipt[] {
    const rows = this.db.prepare("SELECT * FROM authority_receipts ORDER BY seq").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      seq: Number(row.seq),
      requestId: String(row.request_id),
      envelopeDigest: String(row.envelope_digest),
      previousHash: String(row.previous_hash),
      receiptHash: String(row.receipt_hash),
      issuedAt: String(row.issued_at),
      appliedAt: String(row.applied_at),
      actor: String(row.actor),
      action: JSON.parse(String(row.action_json)) as Action,
      result: JSON.parse(String(row.result_json)) as StoredState,
      envelope: JSON.parse(String(row.envelope_json)) as SignedActionEnvelope,
    }));
  }

  receipt(requestId: string, envelopeDigest: string): AuthorityReceipt | null {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId) ||
      !RECEIPT_HASH_PATTERN.test(envelopeDigest)
    ) {
      return null;
    }
    const receipts = this.receipts();
    const integrity = this.verifyReceiptChain(receipts);
    const current = this.state();
    const head = receipts.at(-1);
    if (
      !integrity.ok ||
      current.revision !== receipts.length ||
      (head && !canonicalEqual(head.result, current))
    ) {
      throw new AuthorityError(
        "INTEGRITY_FAILED",
        integrity.ok ? "authority state is not bound to its receipt head" : integrity.reason,
        503,
      );
    }
    return (
      receipts.find(
        (receipt) =>
          receipt.requestId === requestId &&
          receipt.envelopeDigest === envelopeDigest,
      ) ?? null
    );
  }

  private verifyReceiptChain(receipts: AuthorityReceipt[]): { ok: true } | { ok: false; reason: string } {
    if (!this.trust) return { ok: false, reason: "action trust root is not configured" };
    let previousHash = "GENESIS";
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      if (receipt.seq !== index + 1 || receipt.previousHash !== previousHash) {
        return { ok: false, reason: `authority receipt continuity failed at sequence ${receipt.seq}` };
      }
      const parsed = SignedActionEnvelopeSchema.safeParse(receipt.envelope);
      if (!parsed.success) return { ok: false, reason: `authority envelope invalid at sequence ${receipt.seq}` };
      if (
        parsed.data.authorityInstanceId !== this.instanceId ||
        parsed.data.trustEpoch !== this.trustEpoch ||
        parsed.data.expectedRevision !== index ||
        parsed.data.expectedReceiptHash !== previousHash
      ) {
        return { ok: false, reason: `authority envelope CAS binding mismatch at sequence ${receipt.seq}` };
      }
      const bytes = actionEnvelopeBytes(unsignedEnvelope(parsed.data));
      if (sha256Hex(bytes) !== receipt.envelopeDigest) {
        return { ok: false, reason: `authority envelope digest mismatch at sequence ${receipt.seq}` };
      }
      if (
        parsed.data.keyId !== this.trust.keyId ||
        !crypto.verify(null, bytes, this.trust.key, Buffer.from(parsed.data.signature, "base64"))
      ) {
        return { ok: false, reason: `authority signature invalid at sequence ${receipt.seq}` };
      }
      const expectedResult = stateForAction(
        parsed.data.action,
        parsed.data.issuedAt,
        parsed.data.requestId,
        receipt.seq,
      );
      if (
        receipt.requestId !== parsed.data.requestId ||
        receipt.issuedAt !== parsed.data.issuedAt ||
        receipt.actor !== parsed.data.actor ||
        !canonicalEqual(receipt.action, parsed.data.action) ||
        !canonicalEqual(receipt.result, expectedResult)
      ) {
        return { ok: false, reason: `authority receipt binding mismatch at sequence ${receipt.seq}` };
      }
      const expectedHash = sha256Hex(
        canonicalBytes(receiptHashInput({
          seq: receipt.seq,
          requestId: receipt.requestId,
          envelopeDigest: receipt.envelopeDigest,
          previousHash: receipt.previousHash,
          issuedAt: receipt.issuedAt,
          appliedAt: receipt.appliedAt,
          actor: receipt.actor,
          action: receipt.action,
          result: receipt.result,
        })),
      );
      if (expectedHash !== receipt.receiptHash) {
        return { ok: false, reason: `authority receipt hash mismatch at sequence ${receipt.seq}` };
      }
      previousHash = receipt.receiptHash;
    }
    return { ok: true };
  }

  snapshot(): AuthoritySnapshot {
    let durabilityVerified = false;
    let storageError: unknown;
    try {
      if (this.closed) throw new Error("authority store is closed");
      durabilityVerified = this.requireStorage("snapshot");
    } catch (error) {
      storageError = error;
    }
    const authority = {
      enabled: this.trust !== null,
      version: ACTION_ENVELOPE_VERSION,
      keyId: this.trust?.keyId ?? null,
      trustEpoch: this.trustEpoch,
      instanceId: this.instanceId,
      audience: ACTION_AUDIENCE,
      source: {
        repository: ACTION_SOURCE_REPOSITORY,
        revision: this.sourceRevision,
      },
      deployment: {
        space: ACTION_DEPLOYMENT_SPACE,
        revision: this.deploymentRevision,
      },
      durability: {
        required: this.durabilityRequired,
        verified: durabilityVerified,
        path: this.databaseDirectory,
      },
      externalOperator: true as const,
    };
    try {
      if (storageError) throw storageError;
      if (this.closed) throw new Error("authority store is closed");
      const state = this.state();
      const receipts = this.receipts();
      if (!this.trust) {
        return {
          ...safeState(),
          evidenceState: "UNAVAILABLE",
          reason: "signed action trust root is not configured",
          validUntil: null,
          authorityReceiptCount: receipts.length,
          authorityReceiptHash: receipts.at(-1)?.receiptHash ?? null,
          authority,
        };
      }
      const verification = this.verifyReceiptChain(receipts);
      if (!verification.ok) {
        return {
          ...safeState(),
          evidenceState: "FAILED",
          reason: verification.reason,
          validUntil: null,
          authorityReceiptCount: receipts.length,
          authorityReceiptHash: receipts.at(-1)?.receiptHash ?? null,
          authority,
        };
      }
      if (receipts.length === 0 || !state.updatedAt) {
        return {
          ...safeState(),
          evidenceState: "UNAVAILABLE",
          reason: "no verified signed action receipt exists",
          validUntil: null,
          authorityReceiptCount: 0,
          authorityReceiptHash: null,
          authority,
        };
      }
      const latest = receipts.at(-1)!;
      if (!canonicalEqual(latest.result, state)) {
        return {
          ...safeState(),
          evidenceState: "FAILED",
          reason: "authority state does not match the append-only receipt head",
          validUntil: null,
          authorityReceiptCount: receipts.length,
          authorityReceiptHash: latest.receiptHash,
          authority,
        };
      }
      if (
        latest.envelope.source.revision !== this.sourceRevision ||
        latest.envelope.deployment.revision !== this.deploymentRevision
      ) {
        return {
          ...state,
          evidenceState: "STALE",
          reason: "latest signed action targets a different source or Hugging Face deployment revision",
          validUntil: latest.envelope.validUntil,
          authorityReceiptCount: receipts.length,
          authorityReceiptHash: latest.receiptHash,
          authority,
        };
      }
      const nowMs = this.now().getTime();
      const updatedAtMs = Date.parse(state.updatedAt);
      const signedValidUntilMs = Date.parse(latest.envelope.validUntil);
      const validUntilMs = Math.min(
        updatedAtMs + this.maxEvidenceAgeMs,
        signedValidUntilMs,
      );
      const validUntil = Number.isFinite(validUntilMs)
        ? new Date(validUntilMs).toISOString()
        : null;
      const stale =
        !Number.isFinite(updatedAtMs) ||
        !Number.isFinite(signedValidUntilMs) ||
        updatedAtMs - nowMs > MAX_CLOCK_SKEW_MS ||
        validUntilMs <= nowMs;
      return {
        ...state,
        evidenceState: stale ? "STALE" : "VERIFIED",
        reason: stale
          ? "latest signed action receipt is outside its signed validity window"
          : "signed action and receipt chain verified",
        validUntil,
        authorityReceiptCount: receipts.length,
        authorityReceiptHash: latest.receiptHash,
        authority,
      };
    } catch (error) {
      return {
        ...safeState(),
        evidenceState: "UNAVAILABLE",
        reason: `authority state read unavailable: ${error instanceof Error ? error.message : String(error)}`,
        validUntil: null,
        authorityReceiptCount: 0,
        authorityReceiptHash: null,
        authority,
      };
    }
  }

  apply(rawEnvelope: unknown): AuthoritySnapshot {
    if (this.closed) throw new AuthorityError("AUTHORITY_UNAVAILABLE", "authority store is closed", 503);
    this.requireStorage("admission");
    if (!this.trust) {
      throw new AuthorityError("AUTHORITY_UNAVAILABLE", "signed action trust root is not configured", 503);
    }
    if (
      rawEnvelope &&
      typeof rawEnvelope === "object" &&
      "version" in rawEnvelope &&
      (rawEnvelope as { version?: unknown }).version !== ACTION_ENVELOPE_VERSION
    ) {
      throw new AuthorityError(
        "UNSUPPORTED_ENVELOPE_VERSION",
        "only immune.action.v2 envelopes are admitted",
        400,
      );
    }
    const parsed = SignedActionEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      throw new AuthorityError("INVALID_ENVELOPE", "signed action envelope is invalid", 400);
    }
    const envelope = parsed.data;
    if (envelope.action.type === "SET_MODE") {
      if (envelope.action.mode === "DEADMAN" && !envelope.action.tripwire) {
        throw new AuthorityError("INVALID_ACTION", "DEADMAN requires a tripwire", 400);
      }
      if (envelope.action.mode !== "DEADMAN" && envelope.action.tripwire) {
        throw new AuthorityError("INVALID_ACTION", "tripwire is valid only for DEADMAN", 400);
      }
    }
    const now = this.now();
    const issuedAtMs = Date.parse(envelope.issuedAt);
    const expiresAtMs = Date.parse(envelope.expiresAt);
    const validUntilMs = Date.parse(envelope.validUntil);
    const authorityLeaseCapMs =
      envelope.action.type === "RESET" ||
      (envelope.action.type === "SET_MODE" && envelope.action.mode === "PASS")
        ? MAX_PASS_AUTHORITY_LEASE_MS
        : MAX_AUTHORITY_LEASE_MS;
    if (
      issuedAtMs > now.getTime() + MAX_CLOCK_SKEW_MS ||
      expiresAtMs <= now.getTime() ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_ACTION_SUBMISSION_LIFETIME_MS
    ) {
      throw new AuthorityError(
        "INVALID_ADMISSION_WINDOW",
        "signed action admission is expired or outside its five-minute window",
        401,
      );
    }
    if (
      validUntilMs <= expiresAtMs ||
      validUntilMs <= now.getTime() ||
      validUntilMs - issuedAtMs > authorityLeaseCapMs
    ) {
      throw new AuthorityError(
        "INVALID_AUTHORITY_LEASE",
        "signed authority lease exceeds the action-specific validity cap",
        401,
      );
    }
    if (
      envelope.audience !== ACTION_AUDIENCE ||
      envelope.source.repository !== ACTION_SOURCE_REPOSITORY ||
      envelope.source.revision !== this.sourceRevision ||
      envelope.deployment.space !== ACTION_DEPLOYMENT_SPACE ||
      envelope.deployment.revision !== this.deploymentRevision ||
      envelope.trustEpoch !== this.trustEpoch ||
      envelope.authorityInstanceId !== this.instanceId
    ) {
      throw new AuthorityError(
        "INVALID_AUTHORITY_BINDING",
        "signed action does not match the exact audience and deployed source",
        409,
      );
    }
    if (envelope.keyId !== this.trust.keyId) {
      throw new AuthorityError("UNTRUSTED_KEY", "signed action keyId does not match the configured trust root", 401);
    }
    const envelopeBytes = actionEnvelopeBytes(unsignedEnvelope(envelope));
    if (!crypto.verify(null, envelopeBytes, this.trust.key, Buffer.from(envelope.signature, "base64"))) {
      throw new AuthorityError("INVALID_SIGNATURE", "signed action signature verification failed", 401);
    }
    const envelopeDigest = sha256Hex(envelopeBytes);

    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.requireStorage("locked");
      const lockedNow = this.now();
      if (expiresAtMs <= lockedNow.getTime()) {
        throw new AuthorityError(
          "INVALID_ADMISSION_WINDOW",
          "signed action admission expired while waiting for the authority write lock",
          401,
        );
      }
      if (validUntilMs <= lockedNow.getTime()) {
        throw new AuthorityError(
          "INVALID_AUTHORITY_LEASE",
          "signed authority lease expired while waiting for the authority write lock",
          401,
        );
      }
      const appliedAt = lockedNow.toISOString();
      const current = this.state();
      const existingReceipts = this.receipts();
      const integrity = this.verifyReceiptChain(existingReceipts);
      const existingHead = existingReceipts.at(-1);
      if (
        !integrity.ok ||
        current.revision !== existingReceipts.length ||
        (existingHead && !canonicalEqual(existingHead.result, current))
      ) {
        throw new AuthorityError(
          "INTEGRITY_FAILED",
          integrity.ok ? "authority state is not bound to its receipt head" : integrity.reason,
          503,
        );
      }
      const replay = this.db
        .prepare("SELECT envelope_digest FROM authority_receipts WHERE request_id = ?")
        .get(envelope.requestId) as { envelope_digest: string } | undefined;
      if (replay) {
        if (replay.envelope_digest === envelopeDigest) {
          throw new AuthorityError(
            "ALREADY_APPLIED",
            "this exact signed action is already recorded; use receipt readback",
            409,
          );
        }
        throw new AuthorityError(
          "REPLAY_CONFLICT",
          "requestId is already bound to a different signed action",
          409,
        );
      }
      const head = this.db
        .prepare("SELECT seq, receipt_hash FROM authority_receipts ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; receipt_hash: string } | undefined;
      const seq = head ? Number(head.seq) + 1 : 1;
      const previousHash = head?.receipt_hash ?? "GENESIS";
      if (
        envelope.expectedRevision !== current.revision ||
        envelope.expectedRevision !== seq - 1 ||
        envelope.expectedReceiptHash !== previousHash
      ) {
        throw new AuthorityError(
          "STALE_AUTHORITY_HEAD",
          "signed action expected a different authority revision or receipt head",
          409,
        );
      }
      const result = stateForAction(envelope.action, envelope.issuedAt, envelope.requestId, seq);
      const receiptWithoutHash = {
        seq,
        requestId: envelope.requestId,
        envelopeDigest,
        previousHash,
        issuedAt: envelope.issuedAt,
        appliedAt,
        actor: envelope.actor,
        action: envelope.action,
        result,
      };
      const receiptHash = sha256Hex(canonicalBytes(receiptHashInput(receiptWithoutHash)));
      this.db
        .prepare(`
          INSERT INTO authority_receipts
            (seq, request_id, envelope_digest, previous_hash, receipt_hash, issued_at, applied_at,
             actor, action_json, result_json, envelope_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          seq,
          envelope.requestId,
          envelopeDigest,
          previousHash,
          receiptHash,
          envelope.issuedAt,
          appliedAt,
          envelope.actor,
          JSON.stringify(envelope.action),
          JSON.stringify(result),
          JSON.stringify(envelope),
        );
      this.db
        .prepare(`
          UPDATE authority_state
          SET mode = ?, tripwire = ?, deadman = ?, updated_at = ?, last_request_id = ?, revision = ?
          WHERE id = 1
        `)
        .run(
          result.mode,
          result.tripwire,
          result.deadman ? 1 : 0,
          result.updatedAt,
          result.requestId,
          result.revision,
        );
      this.requireStorage("precommit");
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Transaction may already be closed; preserve the original failure.
      }
      if (error instanceof AuthorityError) throw error;
      throw new AuthorityError(
        "PERSISTENCE_FAILED",
        `signed action was not applied: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    }
    const snapshot = this.snapshot();
    if (snapshot.evidenceState !== "VERIFIED") {
      // COMMIT has already completed. Do not retry, roll back, delete, or reset its receipt.
      throw new AuthorityError("POSTCONDITION_FAILED", `signed action may already be committed; reconcile exact receipt without retry: ${snapshot.reason}`, 503);
    }
    return snapshot;
  }
}

let singleton: AuthorityStore | null = null;

function dataDirectory(): string {
  return process.env.IMMUNE_AUTHORITY_DATA_DIR
    ? path.resolve(process.env.IMMUNE_AUTHORITY_DATA_DIR)
    : path.resolve(process.cwd(), "data", "immune", "authority");
}

function store(): AuthorityStore {
  if (!singleton) {
    const configuredPublicKey = process.env.IMMUNE_ACTION_PUBLIC_KEY?.trim();
    const configuredTrustEpochValue = process.env.IMMUNE_ACTION_TRUST_EPOCH?.trim() ?? "";
    if (!configuredPublicKey || !TRUST_EPOCH_PATTERN.test(configuredTrustEpochValue)) {
      throw new Error("action trust root is not configured");
    }
    const configuredKeyId = parsePublicKey(configuredPublicKey)?.keyId ?? "unconfigured";
    singleton = new AuthorityStore({
      databasePath: path.join(
        dataDirectory(),
        `authority-v2-${configuredKeyId}-${configuredTrustEpochValue}.sqlite`,
      ),
      publicKeyB64: configuredPublicKey,
      sourceRevision: process.env.IMMUNE_ACTION_SOURCE_REVISION,
      deploymentRevision: (process.env.HF_SPACE_REVISION ?? "")
        .trim()
        .toLowerCase(),
      trustEpoch: configuredTrustEpochValue,
      maxEvidenceAgeMs: process.env.IMMUNE_EVIDENCE_MAX_AGE_MS
        ? Number(process.env.IMMUNE_EVIDENCE_MAX_AGE_MS)
        : undefined,
      requireDurableStorage:
        process.env.NODE_ENV === "production" || process.env.SPACE_ID === ACTION_AUDIENCE.slice("hf-space:".length),
    });
  }
  return singleton;
}

export function getState(): AuthoritySnapshot {
  try {
    return store().snapshot();
  } catch (error) {
    let configuredTrust: ReturnType<typeof parsePublicKey> = null;
    try {
      configuredTrust = parsePublicKey(process.env.IMMUNE_ACTION_PUBLIC_KEY);
    } catch {
      configuredTrust = null;
    }
    return {
      ...safeState(),
      evidenceState: "UNAVAILABLE",
      reason: `authority initialization unavailable: ${error instanceof Error ? error.message : String(error)}`,
      validUntil: null,
      authorityReceiptCount: 0,
      authorityReceiptHash: null,
      authority: {
        enabled: configuredTrust !== null,
        version: ACTION_ENVELOPE_VERSION,
        keyId: configuredTrust?.keyId ?? null,
        trustEpoch: process.env.IMMUNE_ACTION_TRUST_EPOCH ?? null,
        instanceId: null,
        audience: ACTION_AUDIENCE,
        source: {
          repository: ACTION_SOURCE_REPOSITORY,
          revision: process.env.IMMUNE_ACTION_SOURCE_REVISION ?? null,
        },
        deployment: {
          space: ACTION_DEPLOYMENT_SPACE,
          revision:
            process.env.HF_SPACE_REVISION?.trim().toLowerCase() ?? null,
        },
        durability: {
          required:
            process.env.NODE_ENV === "production" ||
            process.env.SPACE_ID === ACTION_AUDIENCE.slice("hf-space:".length),
          verified: false,
          path: dataDirectory(),
        },
        externalOperator: true,
      },
    };
  }
}

export function applySignedAction(envelope: unknown): AuthoritySnapshot {
  return store().apply(envelope);
}

export function getAuthorityReceipt(
  requestId: string,
  envelopeDigest: string,
): AuthorityReceipt | null {
  return store().receipt(requestId, envelopeDigest);
}
