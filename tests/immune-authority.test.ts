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
  actionEnvelopeBytes,
  authoritativeTripwireState,
  publicAuthoritySnapshot,
  type SignedActionEnvelope,
} from "../server/routes/immune/state";
import {
  CycleReadinessError,
  runGovernedCycle,
  type GovernedCycleDependencies,
} from "../server/routes/immune/cycle";

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
): SignedActionEnvelope {
  const unsigned: Omit<SignedActionEnvelope, "signature"> = {
    version: ACTION_ENVELOPE_VERSION,
    requestId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    actor: "operator:test-suite",
    keyId,
    action,
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, actionEnvelopeBytes(unsigned), privateKey).toString("base64"),
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
  const store = new AuthorityStore({
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

test("valid signed action persists across restart and requestId replay is rejected", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const envelope = signedEnvelope(id.privateKey, id.keyId, now, "restart-proof-0001", {
    type: "SET_MODE",
    mode: "DEADMAN",
    tripwire: "T07",
  });
  const first = new AuthorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
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

  const restarted = new AuthorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  cleanup(t, databasePath, first, restarted);
  const recovered = restarted.snapshot();
  assert.equal(recovered.evidenceState, "VERIFIED");
  assert.equal(recovered.mode, "DEADMAN");
  assert.equal(recovered.tripwire, "T07");
  assert.throws(
    () => restarted.apply(envelope),
    (error: unknown) => error instanceof AuthorityError && error.code === "REPLAY" && error.status === 409,
  );
  assert.equal(restarted.snapshot().authorityReceiptCount, 1);
});

test("invalid signatures and expired actions never mutate durable state", (t) => {
  const trusted = identity();
  const untrusted = identity();
  const databasePath = temporaryDatabase();
  const now = new Date("2026-08-01T12:00:00.000Z");
  const store = new AuthorityStore({ databasePath, publicKeyB64: trusted.publicKeyB64, now: () => now });
  cleanup(t, databasePath, store);

  const badSignature = signedEnvelope(
    untrusted.privateKey,
    trusted.keyId,
    now,
    "bad-signature-0001",
    { type: "SET_MODE", mode: "PASS" },
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
  );
  assert.throws(
    () => store.apply(expired),
    (error: unknown) => error instanceof AuthorityError && error.code === "INVALID_TIME_WINDOW",
  );
  assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
  assert.equal(store.snapshot().mode, "SENTRA_REJECT");
  assert.equal(store.snapshot().authorityReceiptCount, 0);
});

test("fresh signed evidence becomes STALE without becoming green", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  let now = new Date("2026-08-01T12:00:00.000Z");
  const store = new AuthorityStore({
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
    }),
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
  const store = new AuthorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "cycle-pass-state-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }),
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
    }),
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
  const store = new AuthorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
    now: () => now,
  });
  cleanup(t, databasePath, store);
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "readiness-pass-state-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }),
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
  const store = new AuthorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
  store.apply(
    signedEnvelope(id.privateKey, id.keyId, now, "tamper-proof-0001", {
      type: "SET_MODE",
      mode: "PASS",
    }),
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

  const verifier = new AuthorityStore({ databasePath, publicKeyB64: id.publicKeyB64, now: () => now });
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
        }),
      ),
    (error: unknown) => error instanceof AuthorityError && error.code === "INTEGRITY_FAILED",
  );
  assert.equal(verifier.receipts().length, 1);
});

test("read failures are UNAVAILABLE, never PASS", (t) => {
  const id = identity();
  const databasePath = temporaryDatabase();
  const store = new AuthorityStore({
    databasePath,
    publicKeyB64: id.publicKeyB64,
  });
  cleanup(t, databasePath, store);
  store.close();
  const snapshot = store.snapshot();
  assert.equal(snapshot.evidenceState, "UNAVAILABLE");
  assert.equal(snapshot.mode, "SENTRA_REJECT");
});
