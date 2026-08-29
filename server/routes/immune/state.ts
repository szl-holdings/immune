import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalBytes, sha256Hex } from "./canonical";

export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";
export type EvidenceState = "VERIFIED" | "FAILED" | "UNAVAILABLE" | "STALE";

export const ACTION_ENVELOPE_VERSION = "immune.action.v1" as const;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 15 * 60_000;
const MAX_ACTION_LIFETIME_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    actor: z.string().min(3).max(256),
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    action: z.discriminatedUnion("type", [SetModeActionSchema, ResetActionSchema]),
    signature: z.string().min(80).max(128),
  })
  .strict();

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
    demoOperator?: boolean;
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
  maxEvidenceAgeMs?: number;
  now?: () => Date;
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

export class AuthorityStore {
  private readonly db: DatabaseSync;
  private readonly trust: ReturnType<typeof parsePublicKey>;
  private readonly maxEvidenceAgeMs: number;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: AuthorityStoreOptions) {
    this.trust = parsePublicKey(options.publicKeyB64);
    this.maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
    if (!Number.isFinite(this.maxEvidenceAgeMs) || this.maxEvidenceAgeMs <= 0) {
      throw new AuthorityError(
        "INVALID_CONFIGURATION",
        "IMMUNE_EVIDENCE_MAX_AGE_MS must be a positive finite number",
        503,
      );
    }
    this.now = options.now ?? (() => new Date());
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('PASS', 'SENTRA_REJECT', 'DEADMAN')),
        tripwire TEXT,
        deadman INTEGER NOT NULL CHECK (deadman IN (0, 1)),
        updated_at TEXT,
        last_request_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
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
        JSON.stringify(receipt.action) !== JSON.stringify(parsed.data.action) ||
        JSON.stringify(receipt.result) !== JSON.stringify(expectedResult)
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
    const authority = {
      enabled: this.trust !== null,
      version: ACTION_ENVELOPE_VERSION,
      keyId: this.trust?.keyId ?? null,
      demoOperator: process.env.IMMUNE_DEMO_OPERATOR === "1",
    };
    try {
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
      if (JSON.stringify(latest.result) !== JSON.stringify(state)) {
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
      const nowMs = this.now().getTime();
      const updatedAtMs = Date.parse(state.updatedAt);
      const signedExpiresAtMs = Date.parse(latest.envelope.expiresAt);
      const validUntilMs = Math.min(
        updatedAtMs + this.maxEvidenceAgeMs,
        signedExpiresAtMs,
      );
      const validUntil = Number.isFinite(validUntilMs)
        ? new Date(validUntilMs).toISOString()
        : null;
      const stale =
        !Number.isFinite(updatedAtMs) ||
        !Number.isFinite(signedExpiresAtMs) ||
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
    if (!this.trust) {
      throw new AuthorityError("AUTHORITY_UNAVAILABLE", "signed action trust root is not configured", 503);
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
    if (
      issuedAtMs > now.getTime() + MAX_CLOCK_SKEW_MS ||
      expiresAtMs <= now.getTime() ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_ACTION_LIFETIME_MS
    ) {
      throw new AuthorityError("INVALID_TIME_WINDOW", "signed action is expired or outside its bounded time window", 401);
    }
    if (envelope.keyId !== this.trust.keyId) {
      throw new AuthorityError("UNTRUSTED_KEY", "signed action keyId does not match the configured trust root", 401);
    }
    const envelopeBytes = actionEnvelopeBytes(unsignedEnvelope(envelope));
    if (!crypto.verify(null, envelopeBytes, this.trust.key, Buffer.from(envelope.signature, "base64"))) {
      throw new AuthorityError("INVALID_SIGNATURE", "signed action signature verification failed", 401);
    }
    const envelopeDigest = sha256Hex(envelopeBytes);
    const appliedAt = now.toISOString();

    try {
      this.db.exec("BEGIN IMMEDIATE");
      const replay = this.db
        .prepare("SELECT 1 FROM authority_receipts WHERE request_id = ?")
        .get(envelope.requestId);
      if (replay) throw new AuthorityError("REPLAY", "requestId has already been consumed", 409);
      const current = this.state();
      const existingReceipts = this.receipts();
      const integrity = this.verifyReceiptChain(existingReceipts);
      const existingHead = existingReceipts.at(-1);
      if (
        !integrity.ok ||
        current.revision !== existingReceipts.length ||
        (existingHead && JSON.stringify(existingHead.result) !== JSON.stringify(current))
      ) {
        throw new AuthorityError(
          "INTEGRITY_FAILED",
          integrity.ok ? "authority state is not bound to its receipt head" : integrity.reason,
          503,
        );
      }
      const head = this.db
        .prepare("SELECT seq, receipt_hash FROM authority_receipts ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; receipt_hash: string } | undefined;
      const seq = head ? Number(head.seq) + 1 : 1;
      const previousHash = head?.receipt_hash ?? "GENESIS";
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
      throw new AuthorityError("POSTCONDITION_FAILED", snapshot.reason, 503);
    }
    return snapshot;
  }
}

let singleton: AuthorityStore | null = null;

function dataDirectory(): string {
  return process.env.IMMUNE_DATA_DIR
    ? path.resolve(process.env.IMMUNE_DATA_DIR)
    : path.resolve(process.cwd(), "data", "immune");
}

function store(): AuthorityStore {
  if (!singleton) {
    singleton = new AuthorityStore({
      databasePath: path.join(dataDirectory(), "authority.sqlite"),
      publicKeyB64: process.env.IMMUNE_ACTION_PUBLIC_KEY,
      maxEvidenceAgeMs: process.env.IMMUNE_EVIDENCE_MAX_AGE_MS
        ? Number(process.env.IMMUNE_EVIDENCE_MAX_AGE_MS)
        : undefined,
    });
  }
  return singleton;
}

export function getState(): AuthoritySnapshot {
  try {
    return store().snapshot();
  } catch (error) {
    return {
      ...safeState(),
      evidenceState: "UNAVAILABLE",
      reason: `authority initialization unavailable: ${error instanceof Error ? error.message : String(error)}`,
      validUntil: null,
      authorityReceiptCount: 0,
      authorityReceiptHash: null,
      authority: {
        enabled: false,
        version: ACTION_ENVELOPE_VERSION,
        keyId: null,
        demoOperator: process.env.IMMUNE_DEMO_OPERATOR === "1",
      },
    };
  }
}

export function applySignedAction(envelope: unknown): AuthoritySnapshot {
  return store().apply(envelope);
}
