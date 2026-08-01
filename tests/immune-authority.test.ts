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
  type SignedActionEnvelope,
} from "../server/routes/immune/state";

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
  assert.match(stale.reason, /freshness window/);
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
