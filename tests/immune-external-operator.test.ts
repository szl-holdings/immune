import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createExternalActionEnvelope,
  loadExternalOperatorIdentity,
} from "../server/routes/immune/external-operator";
import {
  SignedActionEnvelopeSchema,
  actionEnvelopeBytes,
} from "../server/routes/immune/state";

function testIdentity() {
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    privateKeyB64: privateDer.toString("base64"),
    publicKeyB64: publicDer.subarray(-32).toString("base64"),
  };
}

test("external operator never invents a missing identity", () => {
  assert.throws(
    () => loadExternalOperatorIdentity(undefined, undefined),
    /both required/,
  );
  assert.throws(
    () => loadExternalOperatorIdentity("not-base64", "also-not-base64"),
    /canonical base64/,
  );
});

test("external operator requires a matching Ed25519 public pin", () => {
  const first = testIdentity();
  const second = testIdentity();
  assert.throws(
    () =>
      loadExternalOperatorIdentity(
        first.privateKeyB64,
        second.publicKeyB64,
      ),
    /does not match/,
  );
  const identity = loadExternalOperatorIdentity(
    first.privateKeyB64,
    first.publicKeyB64,
  );
  assert.equal(identity.publicKeyB64, first.publicKeyB64);
  assert.match(identity.keyId, /^[a-f0-9]{16}$/);
});

test("external operator signs the exact v2 audience, source, and lease", () => {
  const pair = testIdentity();
  const identity = loadExternalOperatorIdentity(
    pair.privateKeyB64,
    pair.publicKeyB64,
  );
  const now = new Date("2026-08-29T12:00:00.000Z");
  const envelope = createExternalActionEnvelope({
    identity,
    requestId: "owner-external-proof-0001",
    actor: "github:owner",
    sourceRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    trustEpoch: "1".repeat(32),
    authorityInstanceId: "2".repeat(32),
    expectedRevision: 0,
    expectedReceiptHash: "GENESIS",
    leaseMinutes: 60,
    now,
    action: { type: "SET_MODE", mode: "DEADMAN", tripwire: "T07" },
  });
  assert.equal(envelope.version, "immune.action.v2");
  assert.equal(envelope.audience, "hf-space:SZLHOLDINGS/immune");
  assert.deepEqual(envelope.source, {
    repository: "szl-holdings/immune",
    revision: "a".repeat(40),
  });
  assert.deepEqual(envelope.deployment, {
    space: "SZLHOLDINGS/immune",
    revision: "b".repeat(40),
  });
  assert.equal(envelope.trustEpoch, "1".repeat(32));
  assert.equal(envelope.authorityInstanceId, "2".repeat(32));
  assert.equal(envelope.expectedRevision, 0);
  assert.equal(envelope.expectedReceiptHash, "GENESIS");
  assert.equal(envelope.expiresAt, "2026-08-29T12:04:00.000Z");
  assert.equal(envelope.validUntil, "2026-08-29T13:00:00.000Z");
  assert.equal(SignedActionEnvelopeSchema.safeParse(envelope).success, true);
  const { signature, ...unsigned } = envelope;
  assert.equal(
    crypto.verify(
      null,
      actionEnvelopeBytes(unsigned),
      crypto.createPublicKey(identity.privateKey),
      Buffer.from(signature, "base64"),
    ),
    true,
  );
});

test("external operator rejects stale-shape CAS and overlong PASS leases", () => {
  const pair = testIdentity();
  const identity = loadExternalOperatorIdentity(
    pair.privateKeyB64,
    pair.publicKeyB64,
  );
  const base = {
    identity,
    requestId: "owner-external-negative-0001",
    actor: "github:owner",
    sourceRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    trustEpoch: "1".repeat(32),
    authorityInstanceId: "2".repeat(32),
    expectedRevision: 0,
    expectedReceiptHash: "GENESIS",
    leaseMinutes: 15,
    now: new Date("2026-08-29T12:00:00.000Z"),
    action: { type: "SET_MODE", mode: "PASS" } as const,
  };
  assert.throws(
    () => createExternalActionEnvelope({ ...base, expectedReceiptHash: "a".repeat(64) }),
    /expected receipt hash/,
  );
  assert.throws(
    () => createExternalActionEnvelope({ ...base, leaseMinutes: 16 }),
    /action-specific validity cap/,
  );
  const envelope = createExternalActionEnvelope(base);
  assert.equal(
    SignedActionEnvelopeSchema.safeParse({
      ...envelope,
      unexpected: true,
    }).success,
    false,
  );
});

test("production runtime contains no action private key or self-signer path", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const targets = [
    "server/immune-standalone.ts",
    "server/routes/immune/state.ts",
    "server/routes/immune/external-operator.ts",
    "frontend/deploy/Dockerfile",
  ];
  const source = targets
    .map((target) => fs.readFileSync(path.join(root, target), "utf8"))
    .join("\n");
  for (const forbidden of [
    "bootDemoOperator",
    "loadDemoOperatorIdentity",
    "IMMUNE_DEMO_OPERATOR",
    "IMMUNE_ACTION_PRIVATE_KEY",
    "demo-operator.json",
    "generateKeyPairSync",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(
    fs.existsSync(path.join(root, "server/routes/immune/demo-operator.ts")),
    false,
  );
});
