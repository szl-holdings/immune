import crypto from "node:crypto";

export const REPOSITORY = "szl-holdings/immune" as const;
export const SPACE = "SZLHOLDINGS/immune" as const;
export const RUNTIME = "https://szlholdings-immune.hf.space" as const;
export const DEPLOY_WORKFLOW =
  ".github/workflows/deploy-hf-space.yml" as const;
export const ACTION_AUDIENCE = "hf-space:SZLHOLDINGS/immune" as const;
export const ACTION_VERSION = "immune.action.v2" as const;

export const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
export const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export const INSTANCE_PATTERN = /^[a-f0-9]{32}$/u;
export const EPOCH_PATTERN = /^[a-f0-9]{32}$/u;
export const KEY_ID_PATTERN = /^[a-f0-9]{16}$/u;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type JsonObject = Record<string, any>;
export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";
export type ImmuneAction = {
  type: "SET_MODE";
  mode: ImmuneMode;
  tripwire?: string;
};

export type UnsignedActionEnvelope = {
  version: typeof ACTION_VERSION;
  requestId: string;
  trustEpoch: string;
  authorityInstanceId: string;
  expectedRevision: number;
  expectedReceiptHash: string;
  issuedAt: string;
  expiresAt: string;
  validUntil: string;
  actor: string;
  keyId: string;
  audience: typeof ACTION_AUDIENCE;
  source: { repository: typeof REPOSITORY; revision: string };
  deployment: { space: typeof SPACE; revision: string };
  action: ImmuneAction;
};

export type SignedActionEnvelope = UnsignedActionEnvelope & {
  signature: string;
};

export type VerifiedEvidenceLedger = {
  ok: true;
  count: number;
  first_bad_seq: null;
  durability: {
    required: true;
    verified: true;
    path: "/data/immune/evidence";
    mount_path: "/data";
  };
};

// Independent of READY booleans: require the actual observed evidence volume
// before signing/submitting an action and again when verifying its result.
export function assertVerifiedEvidenceLedger(value: unknown): VerifiedEvidenceLedger {
  const ledger = record(value, "evidence ledger");
  const durability = record(ledger.durability, "evidence ledger durability");
  if (
    ledger.ok !== true || !Number.isSafeInteger(ledger.count) || ledger.count < 1 ||
    ledger.first_bad_seq !== null || durability.required !== true ||
    durability.verified !== true || durability.path !== "/data/immune/evidence" ||
    durability.mount_path !== "/data"
  ) {
    throw new Error("evidence ledger integrity or exact durable volume is unverified");
  }
  return {
    ok: true, count: ledger.count, first_bad_seq: null,
    durability: {
      required: true, verified: true,
      path: "/data/immune/evidence", mount_path: "/data",
    },
  };
}

export type ReleaseReceipt = {
  schema: "szl.immune-hf-release-receipt/v1";
  repository: typeof REPOSITORY;
  source_revision: string;
  workflow: {
    repository: typeof REPOSITORY;
    path: typeof DEPLOY_WORKFLOW;
    run_id: string;
    run_attempt: string;
    ref: "refs/heads/main";
  };
  hf: {
    space: typeof SPACE;
    parent_revision: string;
    revision: string;
  };
  manifest: { path: "hf-deploy-manifest.json"; sha256: string };
  outputs: {
    files: Array<{ path: string; sha256: string }>;
    set_sha256: string;
  };
  volume: {
    type: "bucket";
    source: string;
    mount_path: "/data";
    read_only: false;
  };
  trust: {
    key_id: string;
    trust_epoch: string;
    public_key_sha256: string;
  };
  authority: {
    instance_id: string;
    revision: number;
    receipt_hash: string;
    evidence_state: "UNAVAILABLE" | "STALE";
    durability: { required: true; verified: true; path: string };
  };
  ledger: VerifiedEvidenceLedger;
  readiness: {
    status: "READ_ONLY";
    ready: false;
    runtime_ready: true;
    read_ready: true;
    authority_ready: false;
    write_ready: false;
  };
};

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (actual.some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} is missing required fields`);
  }
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function exactString(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("canonical payload nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical payload contains a non-integer");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  const object = record(value, "canonical payload");
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key], depth + 1)]),
  );
}

export function canonicalBytes(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
  if (bytes.byteLength > 1_048_576) throw new Error("canonical payload is too large");
  return bytes;
}

export function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

export function parseReleaseReceipt(value: unknown): ReleaseReceipt {
  const root = record(value, "release receipt");
  exactKeys(
    root,
    [
      "schema",
      "repository",
      "source_revision",
      "workflow",
      "hf",
      "manifest",
      "outputs",
      "volume",
      "trust",
      "authority",
      "ledger",
      "readiness",
    ],
    "release receipt",
  );
  if (
    root.schema !== "szl.immune-hf-release-receipt/v1" ||
    root.repository !== REPOSITORY ||
    !REVISION_PATTERN.test(root.source_revision)
  ) {
    throw new Error("release receipt source binding is invalid");
  }

  const workflow = record(root.workflow, "release receipt workflow");
  exactKeys(
    workflow,
    ["repository", "path", "run_id", "run_attempt", "ref"],
    "release receipt workflow",
  );
  if (
    workflow.repository !== REPOSITORY ||
    workflow.path !== DEPLOY_WORKFLOW ||
    workflow.ref !== "refs/heads/main"
  ) {
    throw new Error("release receipt workflow binding is invalid");
  }
  if (
    typeof workflow.run_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(workflow.run_id) ||
    !Number.isSafeInteger(Number(workflow.run_id)) ||
    typeof workflow.run_attempt !== "string" ||
    !/^[1-9][0-9]*$/u.test(workflow.run_attempt) ||
    !Number.isSafeInteger(Number(workflow.run_attempt))
  ) {
    throw new Error("release receipt workflow run identity is invalid");
  }

  const hf = record(root.hf, "release receipt hf");
  exactKeys(hf, ["space", "parent_revision", "revision"], "release receipt hf");
  if (
    hf.space !== SPACE ||
    !REVISION_PATTERN.test(hf.parent_revision) ||
    !REVISION_PATTERN.test(hf.revision)
  ) {
    throw new Error("release receipt Hugging Face binding is invalid");
  }

  const manifest = record(root.manifest, "release receipt manifest");
  exactKeys(manifest, ["path", "sha256"], "release receipt manifest");
  if (
    manifest.path !== "hf-deploy-manifest.json" ||
    !DIGEST_PATTERN.test(manifest.sha256)
  ) {
    throw new Error("release receipt manifest binding is invalid");
  }

  const outputs = record(root.outputs, "release receipt outputs");
  exactKeys(outputs, ["files", "set_sha256"], "release receipt outputs");
  if (!Array.isArray(outputs.files) || outputs.files.length === 0) {
    throw new Error("release receipt output file set is empty");
  }
  const outputFiles = outputs.files.map((item, index) => {
    const output = record(item, `release receipt output ${index}`);
    exactKeys(output, ["path", "sha256"], `release receipt output ${index}`);
    if (
      typeof output.path !== "string" ||
      !output.path ||
      output.path.startsWith("/") ||
      output.path.includes("..") ||
      output.path.includes("\\") ||
      !DIGEST_PATTERN.test(output.sha256)
    ) {
      throw new Error(`release receipt output ${index} is invalid`);
    }
    return { path: output.path, sha256: output.sha256 };
  });
  const sorted = [...outputFiles].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    JSON.stringify(outputFiles) !== JSON.stringify(sorted) ||
    new Set(outputFiles.map((file) => file.path)).size !== outputFiles.length ||
    !DIGEST_PATTERN.test(outputs.set_sha256) ||
    sha256(Buffer.from(JSON.stringify(outputFiles), "utf8")) !== outputs.set_sha256
  ) {
    throw new Error("release receipt output set digest or order is invalid");
  }

  const volume = record(root.volume, "release receipt volume");
  exactKeys(volume, ["type", "source", "mount_path", "read_only"], "release receipt volume");
  if (
    volume.type !== "bucket" ||
    typeof volume.source !== "string" ||
    volume.source.length === 0 ||
    volume.mount_path !== "/data" ||
    volume.read_only !== false
  ) {
    throw new Error("release receipt durable volume binding is invalid");
  }

  const trust = record(root.trust, "release receipt trust");
  exactKeys(trust, ["key_id", "trust_epoch", "public_key_sha256"], "release receipt trust");
  exactString(trust.key_id, KEY_ID_PATTERN, "release receipt key_id");
  exactString(trust.trust_epoch, EPOCH_PATTERN, "release receipt trust_epoch");
  exactString(trust.public_key_sha256, DIGEST_PATTERN, "release receipt public_key_sha256");

  const authority = record(root.authority, "release receipt authority");
  exactKeys(
    authority,
    ["instance_id", "revision", "receipt_hash", "evidence_state", "durability"],
    "release receipt authority",
  );
  exactString(authority.instance_id, INSTANCE_PATTERN, "release receipt instance_id");
  const authorityRevision = integer(authority.revision, "release receipt authority revision");
  if (
    (authorityRevision === 0 && authority.receipt_hash !== "GENESIS") ||
    (authorityRevision > 0 && !DIGEST_PATTERN.test(authority.receipt_hash)) ||
    !["UNAVAILABLE", "STALE"].includes(authority.evidence_state)
  ) {
    throw new Error("release receipt authority head is invalid");
  }
  const durability = record(authority.durability, "release receipt authority durability");
  exactKeys(durability, ["required", "verified", "path"], "release receipt authority durability");
  if (
    durability.required !== true ||
    durability.verified !== true ||
    typeof durability.path !== "string" ||
    !durability.path.startsWith("/data/immune")
  ) {
    throw new Error("release receipt authority durability is invalid");
  }

  const ledger = record(root.ledger, "release receipt evidence ledger");
  exactKeys(ledger, ["ok", "count", "first_bad_seq", "durability"], "release receipt evidence ledger");
  exactKeys(record(ledger.durability, "release receipt evidence durability"),
    ["required", "verified", "path", "mount_path"], "release receipt evidence durability");
  assertVerifiedEvidenceLedger(ledger);
  const readiness = record(root.readiness, "release receipt readiness");
  exactKeys(
    readiness,
    [
      "status",
      "ready",
      "runtime_ready",
      "read_ready",
      "authority_ready",
      "write_ready",
    ],
    "release receipt readiness",
  );
  if (
    readiness.status !== "READ_ONLY" ||
    readiness.ready !== false ||
    readiness.runtime_ready !== true ||
    readiness.read_ready !== true ||
    readiness.authority_ready !== false ||
    readiness.write_ready !== false
  ) {
    throw new Error("release receipt must witness exact read-only readiness");
  }
  return root as ReleaseReceipt;
}

export function parseUnsignedEnvelope(value: unknown): UnsignedActionEnvelope {
  const root = record(value, "unsigned authority intent");
  exactKeys(
    root,
    [
      "version",
      "requestId",
      "trustEpoch",
      "authorityInstanceId",
      "expectedRevision",
      "expectedReceiptHash",
      "issuedAt",
      "expiresAt",
      "validUntil",
      "actor",
      "keyId",
      "audience",
      "source",
      "deployment",
      "action",
    ],
    "unsigned authority intent",
  );
  if (
    root.version !== ACTION_VERSION ||
    root.audience !== ACTION_AUDIENCE ||
    !REQUEST_ID_PATTERN.test(root.requestId) ||
    !EPOCH_PATTERN.test(root.trustEpoch) ||
    !INSTANCE_PATTERN.test(root.authorityInstanceId) ||
    !KEY_ID_PATTERN.test(root.keyId) ||
    !Number.isSafeInteger(root.expectedRevision) ||
    root.expectedRevision < 0 ||
    (root.expectedRevision === 0 && root.expectedReceiptHash !== "GENESIS") ||
    (root.expectedRevision > 0 && !DIGEST_PATTERN.test(root.expectedReceiptHash)) ||
    typeof root.actor !== "string" ||
    !/^github:[A-Za-z0-9-]{1,100}$/u.test(root.actor)
  ) {
    throw new Error("unsigned authority intent binding is invalid");
  }
  const issued = Date.parse(root.issuedAt);
  const expires = Date.parse(root.expiresAt);
  const validUntil = Date.parse(root.validUntil);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(validUntil) ||
    expires <= issued ||
    expires - issued > 5 * 60_000 ||
    validUntil <= issued ||
    validUntil - issued > 24 * 60 * 60_000
  ) {
    throw new Error("unsigned authority intent time bounds are invalid");
  }
  const source = record(root.source, "unsigned authority source");
  exactKeys(source, ["repository", "revision"], "unsigned authority source");
  if (source.repository !== REPOSITORY || !REVISION_PATTERN.test(source.revision)) {
    throw new Error("unsigned authority source binding is invalid");
  }
  const deployment = record(root.deployment, "unsigned authority deployment");
  exactKeys(
    deployment,
    ["space", "revision"],
    "unsigned authority deployment",
  );
  if (
    deployment.space !== SPACE ||
    !REVISION_PATTERN.test(deployment.revision)
  ) {
    throw new Error("unsigned authority deployment binding is invalid");
  }
  const action = record(root.action, "unsigned authority action");
  exactKeys(action, ["type", "mode"], "unsigned authority action", ["tripwire"]);
  if (action.type !== "SET_MODE" || !["PASS", "SENTRA_REJECT", "DEADMAN"].includes(action.mode)) {
    throw new Error("unsigned authority mode is invalid");
  }
  if (
    action.mode === "DEADMAN"
      ? !/^T(?:0[1-9]|10)$/u.test(action.tripwire)
      : Object.hasOwn(action, "tripwire")
  ) {
    throw new Error("unsigned authority tripwire binding is invalid");
  }
  if (
    validUntil - issued >
      (action.mode === "PASS" ? 15 * 60_000 : 24 * 60 * 60_000)
  ) {
    throw new Error("unsigned authority lease exceeds the mode-specific cap");
  }
  return root as UnsignedActionEnvelope;
}

export function parseSignedEnvelope(value: unknown): SignedActionEnvelope {
  const root = record(value, "signed authority envelope");
  exactKeys(
    root,
    [...Object.keys(parseUnsignedEnvelope(Object.fromEntries(Object.entries(root).filter(([key]) => key !== "signature"))))],
    "signed authority envelope",
    ["signature"],
  );
  if (!Object.hasOwn(root, "signature")) {
    throw new Error("signed authority envelope is missing signature");
  }
  const signature = canonicalBase64(root.signature, "authority signature");
  if (signature.byteLength !== 64) throw new Error("authority signature must be 64 bytes");
  const unsigned = Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== "signature"),
  );
  return { ...parseUnsignedEnvelope(unsigned), signature: root.signature };
}

export function unsignedEnvelope(envelope: SignedActionEnvelope): UnsignedActionEnvelope {
  const { signature: _signature, ...unsigned } = envelope;
  return parseUnsignedEnvelope(unsigned);
}

export function envelopeDigest(envelope: SignedActionEnvelope): string {
  return sha256(canonicalBytes(unsignedEnvelope(envelope)));
}

export function expectedActionResult(
  envelope: SignedActionEnvelope,
): {
  mode: ImmuneMode;
  tripwire: string | null;
  deadman: boolean;
  updatedAt: string;
  requestId: string;
  revision: number;
} {
  return {
    mode: envelope.action.mode,
    tripwire: envelope.action.mode === "DEADMAN" ? envelope.action.tripwire ?? null : null,
    deadman: envelope.action.mode === "DEADMAN",
    updatedAt: envelope.issuedAt,
    requestId: envelope.requestId,
    revision: envelope.expectedRevision + 1,
  };
}

export function assertExactAppliedAction(
  envelope: SignedActionEnvelope,
  receiptValue: unknown,
  stateValue: unknown,
  readinessValue: unknown,
): void {
  const receipt = record(receiptValue, "authority receipt");
  exactKeys(
    receipt,
    [
      "seq", "requestId", "envelopeDigest", "previousHash", "receiptHash",
      "issuedAt", "appliedAt", "actor", "action", "result", "envelope",
    ],
    "authority receipt",
  );
  const state = record(stateValue, "authority state");
  const readiness = record(readinessValue, "authority readiness");
  const expected = expectedActionResult(envelope);
  const digest = envelopeDigest(envelope);
  const appliedAtMs = typeof receipt.appliedAt === "string"
    ? Date.parse(receipt.appliedAt)
    : Number.NaN;
  // AuthorityStore permits up to 30 seconds of issuer clock skew, but the
  // locked admission check is strictly before expiresAt. Evidence must prove
  // that same bounded admission, including when inspected after lease expiry.
  if (
    receipt.issuedAt !== envelope.issuedAt ||
    receipt.actor !== envelope.actor ||
    !Number.isFinite(appliedAtMs) ||
    new Date(appliedAtMs).toISOString() !== receipt.appliedAt ||
    appliedAtMs < Date.parse(envelope.issuedAt) - 30_000 ||
    appliedAtMs >= Date.parse(envelope.expiresAt)
  ) {
    throw new Error("authority receipt actor or admission time does not match the signed envelope");
  }
  // Keep this exact field projection aligned with AuthorityStore's
  // receiptHashInput. Echoed hashes in state/readiness are not hash proof.
  const computedReceiptHash = sha256(canonicalBytes({
    seq: receipt.seq,
    requestId: receipt.requestId,
    envelopeDigest: receipt.envelopeDigest,
    previousHash: receipt.previousHash,
    issuedAt: receipt.issuedAt,
    appliedAt: receipt.appliedAt,
    actor: receipt.actor,
    action: receipt.action,
    result: receipt.result,
  }));
  if (
    receipt.seq !== envelope.expectedRevision + 1 ||
    receipt.previousHash !== envelope.expectedReceiptHash ||
    receipt.requestId !== envelope.requestId ||
    receipt.envelopeDigest !== digest ||
    canonicalBytes(receipt.envelope).compare(canonicalBytes(envelope)) !== 0 ||
    canonicalBytes(receipt.action).compare(canonicalBytes(envelope.action)) !== 0 ||
    canonicalBytes(receipt.result).compare(canonicalBytes(expected)) !== 0 ||
    typeof receipt.receiptHash !== "string" ||
    !DIGEST_PATTERN.test(receipt.receiptHash) ||
    receipt.receiptHash !== computedReceiptHash
  ) {
    throw new Error("authority receipt does not exactly bind the requested action and CAS head");
  }
  const stateProjection = {
    mode: state.mode,
    tripwire: state.tripwire,
    deadman: state.deadman,
    updatedAt: state.updatedAt,
    requestId: state.requestId,
    revision: state.revision,
  };
  if (
    canonicalBytes(stateProjection).compare(canonicalBytes(expected)) !== 0 ||
    canonicalBytes(state.durableState).compare(canonicalBytes(expected)) !== 0 ||
    state.evidenceState !== "VERIFIED" ||
    state.validUntil !== envelope.validUntil ||
    state.authorityReceiptCount !== receipt.seq ||
    state.authorityReceiptHash !== receipt.receiptHash ||
    state.authority?.instanceId !== envelope.authorityInstanceId ||
    state.authority?.keyId !== envelope.keyId ||
    state.authority?.trustEpoch !== envelope.trustEpoch ||
    state.authority?.source?.repository !== REPOSITORY ||
    state.authority?.source?.revision !== envelope.source.revision ||
    state.authority?.deployment?.space !== envelope.deployment.space ||
    state.authority?.deployment?.revision !== envelope.deployment.revision ||
    state.authority?.durability?.required !== true ||
    state.authority?.durability?.verified !== true
  ) {
    throw new Error("live authority state does not exactly match the requested action");
  }
  const tripwireState = state.tripwireState;
  if (
    !tripwireState ||
    tripwireState.evidenceState !== "VERIFIED" ||
    tripwireState.mode !== expected.mode ||
    tripwireState.deadman !== expected.deadman ||
    tripwireState.tripwire !== expected.tripwire ||
    tripwireState.requestId !== expected.requestId ||
    tripwireState.revision !== expected.revision ||
    tripwireState.updatedAt !== expected.updatedAt ||
    tripwireState.validUntil !== envelope.validUntil
  ) {
    throw new Error("effective tripwire state does not exactly match the requested action");
  }
  assertVerifiedEvidenceLedger(readiness.ledger);
  const pass = envelope.action.mode === "PASS";
  const expectedBlocker =
    envelope.action.mode === "DEADMAN"
      ? "ACTION_AUTHORITY_DEADMAN"
      : envelope.action.mode === "SENTRA_REJECT"
        ? "ACTION_AUTHORITY_SENTRA_REJECT"
        : null;
  if (
    readiness.status !== (pass ? "READY" : "READ_ONLY") ||
    readiness.ready !== pass ||
    readiness.runtime_ready !== true ||
    readiness.read_ready !== true ||
    readiness.authority_ready !== pass ||
    readiness.write_ready !== pass ||
    readiness.authority?.enabled !== true ||
    readiness.authority?.evidence_state !== "VERIFIED" ||
    readiness.authority?.key_id !== envelope.keyId ||
    readiness.authority?.source_revision !== envelope.source.revision ||
    readiness.authority?.deployment?.space !== envelope.deployment.space ||
    readiness.authority?.deployment?.revision !== envelope.deployment.revision ||
    readiness.authority?.receipt_count !== receipt.seq ||
    readiness.authority?.receipt_hash !== receipt.receiptHash ||
    readiness.authority?.durability?.required !== true ||
    readiness.authority?.durability?.verified !== true ||
    (pass
      ? !Array.isArray(readiness.blockers) || readiness.blockers.length !== 0
      : !Array.isArray(readiness.blockers) ||
        readiness.blockers.length !== 1 ||
        readiness.blockers[0] !== expectedBlocker)
  ) {
    throw new Error("whole-system readiness does not exactly match the requested action");
  }
}
