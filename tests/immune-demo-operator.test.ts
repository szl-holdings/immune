import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTION_ENVELOPE_VERSION,
  AuthorityStore,
} from "../server/routes/immune/state";
import {
  loadDemoOperatorIdentity,
  signOperatorAction,
} from "../server/routes/immune/demo-operator";

function temporaryDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "immune-demo-op-"));
  return path.join(directory, "authority.sqlite");
}

test("demo operator is inert without IMMUNE_DEMO_OPERATOR or a private key", () => {
  const prevDemo = process.env.IMMUNE_DEMO_OPERATOR;
  const prevKey = process.env.IMMUNE_ACTION_PRIVATE_KEY;
  delete process.env.IMMUNE_DEMO_OPERATOR;
  delete process.env.IMMUNE_ACTION_PRIVATE_KEY;
  try {
    assert.equal(loadDemoOperatorIdentity(), null);
  } finally {
    if (prevDemo === undefined) delete process.env.IMMUNE_DEMO_OPERATOR;
    else process.env.IMMUNE_DEMO_OPERATOR = prevDemo;
    if (prevKey === undefined) delete process.env.IMMUNE_ACTION_PRIVATE_KEY;
    else process.env.IMMUNE_ACTION_PRIVATE_KEY = prevKey;
  }
});

test("demo operator signs genesis PASS and the store becomes VERIFIED", (t) => {
  const prev = process.env.IMMUNE_DEMO_OPERATOR;
  process.env.IMMUNE_DEMO_OPERATOR = "1";
  const identity = loadDemoOperatorIdentity();
  assert.ok(identity);
  assert.equal(identity.demo, true);
  assert.match(identity.keyId, /^[a-f0-9]{16}$/);

  const databasePath = temporaryDatabase();
  const store = new AuthorityStore({
    databasePath,
    publicKeyB64: identity.publicKeyB64,
  });
  t.after(() => {
    store.close();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    if (prev === undefined) delete process.env.IMMUNE_DEMO_OPERATOR;
    else process.env.IMMUNE_DEMO_OPERATOR = prev;
  });

  assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
  const envelope = signOperatorAction(
    identity,
    { type: "SET_MODE", mode: "PASS" },
    "immune:demo-operator",
  );
  assert.equal(envelope.version, ACTION_ENVELOPE_VERSION);
  const applied = store.apply(envelope);
  assert.equal(applied.evidenceState, "VERIFIED");
  assert.equal(applied.mode, "PASS");
  assert.equal(applied.deadman, false);
  assert.equal(applied.authorityReceiptCount, 1);
  assert.equal(applied.authority.demoOperator, true);
});

test("private key must match a configured public trust root", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(-32).toString("base64");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const other = crypto.generateKeyPairSync("ed25519").publicKey;
  const otherSpki = other.export({ format: "der", type: "spki" }) as Buffer;
  const otherPub = otherSpki.subarray(-32).toString("base64");

  const prevPub = process.env.IMMUNE_ACTION_PUBLIC_KEY;
  const prevPriv = process.env.IMMUNE_ACTION_PRIVATE_KEY;
  const prevDemo = process.env.IMMUNE_DEMO_OPERATOR;
  delete process.env.IMMUNE_DEMO_OPERATOR;
  process.env.IMMUNE_ACTION_PRIVATE_KEY = pkcs8.toString("base64");
  process.env.IMMUNE_ACTION_PUBLIC_KEY = otherPub;
  try {
    assert.throws(
      () => loadDemoOperatorIdentity(),
      /does not match IMMUNE_ACTION_PUBLIC_KEY/,
    );
    process.env.IMMUNE_ACTION_PUBLIC_KEY = pub;
    const identity = loadDemoOperatorIdentity();
    assert.ok(identity);
    assert.equal(identity.publicKeyB64, pub);
    assert.equal(identity.demo, false);
  } finally {
    if (prevPub === undefined) delete process.env.IMMUNE_ACTION_PUBLIC_KEY;
    else process.env.IMMUNE_ACTION_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.IMMUNE_ACTION_PRIVATE_KEY;
    else process.env.IMMUNE_ACTION_PRIVATE_KEY = prevPriv;
    if (prevDemo === undefined) delete process.env.IMMUNE_DEMO_OPERATOR;
    else process.env.IMMUNE_DEMO_OPERATOR = prevDemo;
  }
});
