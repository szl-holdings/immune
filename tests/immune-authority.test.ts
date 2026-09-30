import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ACTION_ENVELOPE_VERSION,
  AuthorityError,
  AuthorityStore,
  SignedActionEnvelopeSchema,
  actionEnvelopeBytes,
  authoritativeTripwireState,
  publicAuthoritySnapshot,
  type AuthorityStoreOptions,
  type SignedActionEnvelope,
} from "../server/routes/immune/state";
import {
  CycleReadinessError,
  runGovernedCycle,
  type GovernedCycleDependencies,
} from "../server/routes/immune/cycle";

const SOURCE_REVISION = "a".repeat(40);
const DEPLOYMENT_REVISION = "b".repeat(40);
const TRUST_EPOCH = "1".repeat(32);

function authorityStore(options: AuthorityStoreOptions): AuthorityStore {
  return new AuthorityStore({
    sourceRevision: SOURCE_REVISION,
    deploymentRevision: DEPLOYMENT_REVISION,
    trustEpoch: TRUST_EPOCH,
    ...options,
  });
}

function identity(): {
  privateKey: crypto.KeyObject;
  publicKeyB64: string;
  keyId: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return {
    privateKey,
    publicKeyB64: raw.toString("base64"),
    keyId: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

function signedEnvelope(
  privateKey: crypto.KeyObject,
  keyId: string,
  now: Date,
  requestId: string,
  action: SignedActionEnvelope["action"],
  options: {
    sourceRevision?: string;
    deploymentRevision?: string;
    trustEpoch?: string;
    authorityInstanceId?: string;
    expectedRevision?: number;
    expectedReceiptHash?: string;
    expiresAfterMs?: number;
    validForMs?: number;
  } = {},
): SignedActionEnvelope {
  const unsigned: Omit<SignedActionEnvelope, "signature"> = {
    version: ACTION_ENVELOPE_VERSION,
    requestId,
    trustEpoch: options.trustEpoch ?? TRUST_EPOCH,
    authorityInstanceId: options.authorityInstanceId ?? "0".repeat(32),
    expectedRevision: options.expectedRevision ?? 0,
    expectedReceiptHash: options.expectedReceiptHash ?? "GENESIS",
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (options.expiresAfterMs ?? 30_000),
    ).toISOString(),
    validUntil: new Date(
      now.getTime() + (options.validForMs ?? 60_000),
    ).toISOString(),
    actor: "operator:test-suite",
    keyId,
    audience: "hf-space:SZLHOLDINGS/immune",
    source: {
      repository: "szl-holdings/immune",
      revision: options.sourceRevision ?? SOURCE_REVISION,
    },
    deployment: {
      space: "SZLHOLDINGS/immune",
      revision: options.deploymentRevision ?? DEPLOYMENT_REVISION,
    },
    action,
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, actionEnvelopeBytes(unsigned), privateKey).toString("base64"),
  };
}

function expectedHead(store: AuthorityStore): {
  trustEpoch: string;
  authorityInstanceId: string;
  expectedRevision: number;
  expectedReceiptHash: string;
} {
  const snapshot = store.snapshot();
  assert.ok(snapshot.authority.instanceId);
  const receipts = store.receipts();
  return {
    trustEpoch: TRUST_EPOCH,
    authorityInstanceId: snapshot.authority.instanceId,
    expectedRevision: receipts.length,
    expectedReceiptHash: receipts.at(-1)?.receiptHash ?? "GENESIS",
  };
}

function temporaryDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "immune-authority-"));
  return path.join(directory, "authority.sqlite");
}

function cleanup(t: test.TestContext, databasePath: string, ...stores: AuthorityStore[]): void {
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  });
}

test("fresh authority is UNAVAILABLE and fail-closed in WAL mode", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
  });
  cleanup(t, databasePath, store);

  assert.equal(store.journalMode(), "wal");
  assert.deepEqual(
    {
      evidenceState: store.snapshot().evidenceState,
      mode: store.snapshot().mode,
      receiptCount: store.snapshot().authorityReceiptCount,
    },
    { evidenceState: "UNAVAILABLE", mode: "SENTRA_REJECT", receiptCount: 0 },
  );
  assert.deepEqual(
    authoritativeTripwireState(store.snapshot()),
    {
      evidenceState: "UNAVAILABLE",
      mode: "SENTRA_REJECT",
      deadman: false,
      tripwire: null,
      reason: "no verified signed action receipt exists",
      validUntil: null,
      updatedAt: null,
      requestId: null,
      revision: 0,
    },
  );
});

test("valid signed action persists across restart and exact replay is recognized", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const first = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  const envelope = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "restart-proof-0001",
    {
      type: "SET_MODE",
      mode: "DEADMAN",
      tripwire: "T07",
    },
    expectedHead(first),
  );
  const applied = first.apply(envelope);
  assert.equal(applied.evidenceState, "VERIFIED");
  assert.equal(applied.deadman, true);
  assert.equal(applied.authorityReceiptCount, 1);
  assert.deepEqual(
    authoritativeTripwireState(applied),
    {
      evidenceState: "VERIFIED",
      mode: "DEADMAN",
      deadman: true,
      tripwire: "T07",
      reason: "signed action and receipt chain verified",
      validUntil: "2026-08-01T12:01:00.000Z",
      updatedAt: now.toISOString(),
      requestId: "restart-proof-0001",
      revision: 1,
    },
  );
  assert.deepEqual(
    authoritativeTripwireState({ ...applied, mode: "PASS" }),
    {
      evidenceState: "FAILED",
      mode: "SENTRA_REJECT",
      deadman: false,
      tripwire: null,
      reason: "verified authority state contains an inconsistent tripwire binding",
      validUntil: "2026-08-01T12:01:00.000Z",
      updatedAt: now.toISOString(),
      requestId: "restart-proof-0001",
      revision: 1,
    },
  );
  first.close();

  const restarted = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  cleanup(t, databasePath, first, restarted);
  const recovered = restarted.snapshot();
  assert.equal(recovered.evidenceState, "VERIFIED");
  assert.equal(recovered.mode, "DEADMAN");
  assert.equal(recovered.tripwire, "T07");
  assert.equal(recovered.authority.instanceId, applied.authority.instanceId);
  assert.throws(
    () => restarted.apply(envelope),
    (error: unknown) =>
      error instanceof AuthorityError &&
      error.code === "ALREADY_APPLIED" &&
      error.status === 409,
  );
  assert.equal(restarted.snapshot().authorityReceiptCount, 1);
});

test("admission expiry is separate from the signed authority lease", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  let now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "lease-window-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );
  now = new Date("2026-08-01T12:00:31.000Z");
  assert.equal(store.snapshot().evidenceState, "VERIFIED");
  now = new Date("2026-08-01T12:01:00.000Z");
  assert.equal(store.snapshot().evidenceState, "STALE");
  assert.equal(authoritativeTripwireState(store.snapshot()).mode, "SENTRA_REJECT");
});

test("v1, unknown fields, invalid lease, and wrong source write no receipt", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  const valid = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "negative-contract-0001",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(store),
  );
  assert.throws(
    () => store.apply({ ...valid, version: "immune.action.v1" }),
    (error: unknown) =>
      error instanceof AuthorityError &&
      error.code === "UNSUPPORTED_ENVELOPE_VERSION",
  );
  assert.throws(
    () => store.apply({ ...valid, unexpected: true }),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "INVALID_ENVELOPE",
  );
  const missingCas = { ...valid } as Partial<SignedActionEnvelope>;
  delete missingCas.expectedRevision;
  assert.equal(SignedActionEnvelopeSchema.safeParse(missingCas).success, false);
  assert.equal(
    SignedActionEnvelopeSchema.safeParse({
      ...valid,
      expectedReceiptHash: "a".repeat(64),
    }).success,
    false,
  );
  const excessiveLease = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "negative-lease-0002",
    { type: "SET_MODE", mode: "PASS" },
    { ...expectedHead(store), validForMs: 24 * 60 * 60_000 + 1 },
  );
  assert.throws(
    () => store.apply(excessiveLease),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "INVALID_AUTHORITY_LEASE",
  );
  const wrongSource = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "negative-source-0003",
    { type: "SET_MODE", mode: "PASS" },
    { ...expectedHead(store), sourceRevision: "b".repeat(40) },
  );
  assert.throws(
    () => store.apply(wrongSource),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "INVALID_AUTHORITY_BINDING",
  );
  assert.equal(store.receipts().length, 0);
  assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
});

test("PASS and RESET leases are capped at 15 minutes", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  for (const [requestId, action] of [
    ["pass-cap-proof-0001", { type: "SET_MODE", mode: "PASS" }],
    ["reset-cap-proof-0002", { type: "RESET" }],
  ] as const) {
    assert.throws(
      () =>
        store.apply(
          signedEnvelope(id.privateKey, id.keyId, now, requestId, action, {
            ...expectedHead(store),
            validForMs: 15 * 60_000 + 1,
          }),
        ),
      (error: unknown) =>
        error instanceof AuthorityError && error.code === "INVALID_AUTHORITY_LEASE",
    );
  }
  const deadman = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "deadman-long-lease-0003",
    { type: "SET_MODE", mode: "DEADMAN", tripwire: "T07" },
    { ...expectedHead(store), validForMs: 16 * 60_000 },
  );
  assert.equal(store.apply(deadman).mode, "DEADMAN");
});

test("signed receipt-head CAS prevents delayed PASS from overriding newer DEADMAN", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  const genesis = expectedHead(store);
  const delayedPass = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "delayed-pass-proof-0001",
    { type: "SET_MODE", mode: "PASS" },
    genesis,
  );
  const newerDeadman = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "newer-deadman-proof-0002",
    { type: "SET_MODE", mode: "DEADMAN", tripwire: "T07" },
    genesis,
  );
  store.apply(newerDeadman);
  assert.throws(
    () => store.apply(delayedPass),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "STALE_AUTHORITY_HEAD",
  );
  assert.equal(store.receipts().length, 1);
  assert.equal(store.snapshot().mode, "DEADMAN");
});

test("post-lock expiry rejects without mutation and locked time becomes appliedAt", (t) => {
  const id = identity();
  const expiredDatabase = temporaryDatabase();
  const issuedAt = new Date("2026-08-01T12:00:00.000Z");
  let lockClock = false;
  let clockReads = 0;
  const expiringStore = authorityStore({
    databasePath: expiredDatabase,
    publicKeyB64: id.publicKeyB64,
    now: () => {
      if (!lockClock) return issuedAt;
      clockReads += 1;
      return clockReads === 1
        ? issuedAt
        : new Date(issuedAt.getTime() + 30_000);
    },
  });
  cleanup(t, expiredDatabase, expiringStore);
  const expiringEnvelope = signedEnvelope(
    id.privateKey,
    id.keyId,
    issuedAt,
    "post-lock-expiry-0001",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(expiringStore),
  );
  lockClock = true;
  assert.throws(
    () => expiringStore.apply(expiringEnvelope),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "INVALID_ADMISSION_WINDOW",
  );
  assert.equal(expiringStore.receipts().length, 0);
  assert.equal(expiringStore.snapshot().revision, 0);

  const appliedDatabase = temporaryDatabase();
  clockReads = 0;
  const appliedStore = authorityStore({
    databasePath: appliedDatabase,
    publicKeyB64: id.publicKeyB64,
    now: () => {
      clockReads += 1;
      return clockReads === 1
        ? issuedAt
        : new Date(issuedAt.getTime() + 5_000);
    },
  });
  cleanup(t, appliedDatabase, appliedStore);
  const appliedEnvelope = signedEnvelope(
    id.privateKey,
    id.keyId,
    issuedAt,
    "post-lock-applied-at-0002",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(appliedStore),
  );
  clockReads = 0;
  appliedStore.apply(appliedEnvelope);
  assert.equal(appliedStore.receipts()[0].appliedAt, "2026-08-01T12:00:05.000Z");
});

test("exact receipt readback reconciles an ambiguous POST without replay mutation", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  const envelope = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "receipt-readback-0001",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(store),
  );
  store.apply(envelope);
  const { signature: _signature, ...unsigned } = envelope;
  const digest = crypto
    .createHash("sha256")
    .update(actionEnvelopeBytes(unsigned))
    .digest("hex");
  const receipt = store.receipt(envelope.requestId, digest);
  assert.ok(receipt);
  assert.equal(receipt.envelopeDigest, digest);
  assert.equal(store.receipt(envelope.requestId, "f".repeat(64)), null);
  assert.equal(store.receipt("different-request-0002", digest), null);
  assert.throws(
    () => store.apply(envelope),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "ALREADY_APPLIED",
  );
  assert.equal(store.receipts().length, 1);
});

test("database loss changes the instance identity and captured envelopes cannot replay", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const original = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  const captured = signedEnvelope(
    id.privateKey,
    id.keyId,
    now,
    "lost-store-envelope-0001",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(original),
  );
  const originalInstance = original.snapshot().authority.instanceId;
  original.close();
  fs.rmSync(databasePath, { force: true });
  const replacement = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, original, replacement);
  assert.notEqual(replacement.snapshot().authority.instanceId, originalInstance);
  assert.throws(
    () => replacement.apply(captured),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "INVALID_AUTHORITY_BINDING",
  );
  assert.equal(replacement.receipts().length, 0);
});

test("a database is pinned to one public key and trust epoch", (t) => {
  const firstIdentity = identity();
  const secondIdentity = identity();
  const databasePath = temporaryDatabase();
  const first = authorityStore({
    databasePath,
    publicKeyB64: firstIdentity.publicKeyB64,
  });
  first.close();
  cleanup(t, databasePath, first);
  assert.throws(
    () =>
      authorityStore({
        databasePath,
        publicKeyB64: secondIdentity.publicKeyB64,
      }),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "KEY_EPOCH_MISMATCH",
  );
  assert.throws(
    () =>
      authorityStore({
        databasePath,
        publicKeyB64: firstIdentity.publicKeyB64,
        trustEpoch: "2".repeat(32),
      }),
    (error: unknown) =>
      error instanceof AuthorityError && error.code === "TRUST_EPOCH_MISMATCH",
  );
});

test("required durable storage fails closed and is visible in authority metadata", (t) => {
  const id = identity();
  const unavailablePath = temporaryDatabase();
  assert.throws(
    () =>
      authorityStore({
        databasePath: unavailablePath,
        publicKeyB64: id.publicKeyB64,
        requireDurableStorage: true,
        durabilityCheck: () => false,
      }),
    (error: unknown) =>
      error instanceof AuthorityError &&
      error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE",
  );
  fs.rmSync(path.dirname(unavailablePath), { recursive: true, force: true });

  const databasePath = temporaryDatabase();
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    requireDurableStorage: true,
    durabilityCheck: () => true,
  });
  cleanup(t, databasePath, store);
  assert.deepEqual(store.snapshot().authority.durability, {
    required: true,
    verified: true,
    path: path.dirname(path.resolve(databasePath)),
  });
});

test("old-source history goes stale and a fresh-source action can append", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const first = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  first.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "source-a-proof-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(first)),
  );
  first.close();

  const nextRevision = "c".repeat(40);
  const nextDeploymentRevision = "d".repeat(40);
  const second = new AuthorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    sourceRevision: nextRevision,
    deploymentRevision: nextDeploymentRevision,
    trustEpoch: TRUST_EPOCH,
    now: () => now,
  });
  cleanup(t, databasePath, first, second);
  assert.equal(second.snapshot().evidenceState, "STALE");
  assert.equal(authoritativeTripwireState(second.snapshot()).mode, "SENTRA_REJECT");
  const applied = second.apply(
    signedEnvelope(
      id.privateKey,
      id.keyId,
      now,
      "source-b-proof-0002",
      { type: "SET_MODE", mode: "PASS" },
      {
        ...expectedHead(second),
        sourceRevision: nextRevision,
        deploymentRevision: nextDeploymentRevision,
      },
    ),
  );
  assert.equal(applied.evidenceState, "VERIFIED");
  assert.equal(applied.authorityReceiptCount, 2);
  assert.equal(applied.authority.deployment.revision, nextDeploymentRevision);
});

test("missing or malformed current deployment binding fails before database creation", () => {
  const id = identity();
  for (const deploymentRevision of ["", "not-a-revision"]) {
    const databasePath = temporaryDatabase();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    assert.throws(
      () =>
        new AuthorityStore({
          databasePath,
          publicKeyB64: id.publicKeyB64,
          sourceRevision: SOURCE_REVISION,
          deploymentRevision,
          trustEpoch: TRUST_EPOCH,
        }),
      (error: unknown) =>
        error instanceof AuthorityError &&
        error.code === "INVALID_DEPLOYMENT_BINDING",
    );
    assert.equal(fs.existsSync(databasePath), false);
  }
});

test("invalid signatures and expired actions never mutate durable state", (t) => {
  const trusted = identity();
  const untrusted = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({ databasePath, publicKeyB64: trusted.publicKeyB64, now: () => now });
  cleanup(t, databasePath, store);

  const badSignature = signedEnvelope(
    untrusted.privateKey,
    trusted.keyId,
    now,
    "bad-signature-0001",
    { type: "SET_MODE", mode: "PASS" },
    expectedHead(store),
  );
  assert.throws(
    () => store.apply(badSignature),
    (error: unknown) => error instanceof AuthorityError && error.code === "INVALID_SIGNATURE",
  );

  const expiredAt = new Date(now.getTime() - 120_000);
  const expired = signedEnvelope(
    trusted.privateKey,
    trusted.keyId,
    expiredAt,
    "expired-action-0001",
    { type: "RESET" },
    expectedHead(store),
  );
  assert.throws(
    () => store.apply(expired),
    (error: unknown) => error instanceof AuthorityError && error.code === "INVALID_ADMISSION_WINDOW",
  );
  assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
  assert.equal(store.snapshot().mode, "SENTRA_REJECT");
  assert.equal(store.snapshot().authorityReceiptCount, 0);
});

test("fresh signed evidence becomes STALE without becoming green", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  let now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
    maxEvidenceAgeMs: 1_000,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "stale-proof-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );
  now = new Date(now.getTime() + 1_001);
  const stale = store.snapshot();
  assert.equal(stale.evidenceState, "STALE");
  assert.equal(stale.mode, "PASS");
  assert.match(stale.reason, /signed validity window/);
  assert.equal(authoritativeTripwireState(stale).mode, "SENTRA_REJECT");
  assert.equal(authoritativeTripwireState(stale).deadman, false);
  assert.equal(authoritativeTripwireState(stale).tripwire, null);
  const publicState = publicAuthoritySnapshot(stale);
  assert.equal(publicState.mode, "SENTRA_REJECT");
  assert.equal(publicState.deadman, false);
  assert.equal(publicState.tripwire, null);
  assert.equal(publicState.durableState.mode, "PASS");
  assert.deepEqual(
    {
      evidenceState: publicState.evidenceState,
      mode: publicState.mode,
      deadman: publicState.deadman,
      tripwire: publicState.tripwire,
      validUntil: publicState.validUntil,
    },
    {
      evidenceState: publicState.tripwireState.evidenceState,
      mode: publicState.tripwireState.mode,
      deadman: publicState.tripwireState.deadman,
      tripwire: publicState.tripwireState.tripwire,
      validUntil: publicState.tripwireState.validUntil,
    },
  );
});

test("concurrent signed DEADMAN prevents a stale PASS receipt", async (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "cycle-pass-state-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );

  let signalAppendStarted = () => undefined;
  const appendStarted = new Promise<void>((resolve) => {
    signalAppendStarted = resolve;
  });
  let releaseAppend = () => undefined;
  const appendBarrier = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  let persisted = 0;
  const dependencies: GovernedCycleDependencies = {
    readiness: () => ({ write_ready: true, blockers: [] }),
    getAuthorityState: () => store.snapshot(),
    appendReceipt: async (input, beforeAppend) => {
      signalAppendStarted();
      await appendBarrier;
      beforeAppend?.();
      persisted += 1;
      return {
        seq: persisted,
        ts: now.toISOString(),
        prevHash: "GENESIS",
        hash: "c".repeat(64),
        payload: input.payload,
      };
    },
    appendEvidence: () => undefined,
    ledgerCount: () => persisted,
  };

  const cycle = runGovernedCycle(
    { actor: "operator:test-suite", intent: "read verified system state" },
    undefined,
    dependencies,
  );
  await appendStarted;
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "cycle-deadman-0002", {
      type: "SET_MODE",
      mode: "DEADMAN",
      tripwire: "T07",
    }, expectedHead(store)),
  );
  releaseAppend();

  const result = await cycle;
  assert.equal(result.pass, false);
  assert.equal(result.receipt, null);
  assert.equal(result.sentra.accepted, false);
  assert.equal(result.sentra.signatureMatched, "guard.authority-revision");
  assert.equal(persisted, 0);
  assert.equal(authoritativeTripwireState(store.snapshot()).deadman, true);
});

test("governed cycles refuse every write before authority or ledger access when readiness is false", async () => {
  const calls = { authority: 0, receipt: 0, evidence: 0, ledger: 0 };
  const dependencies: GovernedCycleDependencies = {
    readiness: () => ({
      write_ready: false,
      blockers: ["RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED"],
    }),
    getAuthorityState: () => {
      calls.authority += 1;
      throw new Error("authority must not be read");
    },
    appendReceipt: async () => {
      calls.receipt += 1;
      throw new Error("receipt must not be written");
    },
    appendEvidence: () => {
      calls.evidence += 1;
    },
    ledgerCount: () => {
      calls.ledger += 1;
      return 0;
    },
  };

  await assert.rejects(
    runGovernedCycle(
      { actor: "operator:test-suite", intent: "attempt blocked write" },
      undefined,
      dependencies,
    ),
    (error: unknown) =>
      error instanceof CycleReadinessError &&
      error.blockers.includes("RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED"),
  );
  assert.deepEqual(calls, { authority: 0, receipt: 0, evidence: 0, ledger: 0 });
});

test("readiness drift before O_EXCL-style receipt persistence leaves no receipt or evidence", async (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "readiness-pass-state-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );

  let readinessReads = 0;
  let persisted = 0;
  let evidence = 0;
  const dependencies: GovernedCycleDependencies = {
    readiness: () => {
      readinessReads += 1;
      return readinessReads === 1
        ? { write_ready: true, blockers: [] }
        : { write_ready: false, blockers: ["RECEIPT_LEDGER_INTEGRITY_FAILED"] };
    },
    getAuthorityState: () => store.snapshot(),
    appendReceipt: async (input, beforeAppend) => {
      beforeAppend?.();
      persisted += 1;
      return {
        seq: persisted,
        ts: now.toISOString(),
        prevHash: "GENESIS",
        hash: "d".repeat(64),
        payload: input.payload,
      };
    },
    appendEvidence: () => {
      evidence += 1;
    },
    ledgerCount: () => persisted,
  };

  await assert.rejects(
    runGovernedCycle(
      { actor: "operator:test-suite", intent: "persist a guarded receipt" },
      undefined,
      dependencies,
    ),
    (error: unknown) =>
      error instanceof CycleReadinessError &&
      error.blockers.includes("RECEIPT_LEDGER_INTEGRITY_FAILED"),
  );
  assert.equal(readinessReads, 2);
  assert.equal(persisted, 0);
  assert.equal(evidence, 0);
});

test("receipt tampering fails closed and append-only triggers reject mutation", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "tamper-proof-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );
  store.close();

  const attacker = new DatabaseSync(databasePath);
  assert.throws(
    () => attacker.exec("UPDATE authority_receipts SET actor = 'attacker' WHERE seq = 1"),
    /append-only/,
  );
  attacker.exec("DROP TRIGGER authority_receipts_no_update");
  attacker.exec("UPDATE authority_receipts SET actor = 'attacker' WHERE seq = 1");
  attacker.close();

  const verifier = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  cleanup(t, databasePath, store, verifier);
  const snapshot = verifier.snapshot();
  assert.equal(snapshot.evidenceState, "FAILED");
  assert.equal(snapshot.mode, "SENTRA_REJECT");
  assert.match(snapshot.reason, /binding mismatch|receipt hash mismatch/);
  assert.throws(
    () =>
      verifier.apply(
        signedEnvelope(id.privateKey, id.keyId, now, "tamper-followup-0002", {
          type: "SET_MODE",
          mode: "PASS",
        }, expectedHead(verifier)),
      ),
    (error: unknown) => error instanceof AuthorityError && error.code === "INTEGRITY_FAILED",
  );
  assert.equal(verifier.receipts().length, 1);
});

test("receipt integrity is canonical and independent of stored object key order", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "canonical-order-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }, expectedHead(store)),
  );
  const receipt = store.receipts()[0];
  store.close();

  const storage = new DatabaseSync(databasePath);
  storage.exec("DROP TRIGGER authority_receipts_no_update");
  storage
    .prepare("UPDATE authority_receipts SET action_json = ?, result_json = ? WHERE seq = 1")
    .run(
      JSON.stringify({ mode: receipt.action.mode, type: receipt.action.type }),
      JSON.stringify({
        revision: receipt.result.revision,
        requestId: receipt.result.requestId,
        updatedAt: receipt.result.updatedAt,
        deadman: receipt.result.deadman,
        tripwire: receipt.result.tripwire,
        mode: receipt.result.mode,
      }),
    );
  storage.close();

  const verifier = authorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  cleanup(t, databasePath, store, verifier);
  const snapshot = verifier.snapshot();
  assert.equal(snapshot.evidenceState, "VERIFIED");
  assert.equal(snapshot.mode, "PASS");
  assert.equal(verifier.receipt(receipt.requestId, receipt.envelopeDigest)?.receiptHash, receipt.receiptHash);
});

test("read failures are UNAVAILABLE, never PASS", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const store = authorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
  });
  cleanup(t, databasePath, store);
  store.close();
  const snapshot = store.snapshot();
  assert.equal(snapshot.evidenceState, "UNAVAILABLE");
  assert.equal(snapshot.mode, "SENTRA_REJECT");
});
