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

function withEnv(t: test.TestContext, patch: Record<string, string | undefined>): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("demo operator is inert without IMMUNE_DEMO_OPERATOR or a private key", (t) => {
  withEnv(t, {
    IMMUNE_DEMO_OPERATOR: undefined,
    IMMUNE_ACTION_PRIVATE_KEY: undefined,
  });
  assert.equal(loadDemoOperatorIdentity(), null);
});

test("demo operator signs genesis PASS and the store becomes VERIFIED", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "immune-demo-data-"));
  withEnv(t, {
    IMMUNE_DEMO_OPERATOR: "1",
    IMMUNE_ACTION_PRIVATE_KEY: undefined,
    IMMUNE_DATA_DIR: dataDir,
  });
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
    fs.rmSync(dataDir, { recursive: true, force: true });
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

test("demo operator reuses the persisted keypair after a reload", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "immune-demo-persist-"));
  withEnv(t, {
    IMMUNE_DEMO_OPERATOR: "1",
    IMMUNE_ACTION_PRIVATE_KEY: undefined,
    IMMUNE_DATA_DIR: dataDir,
  });
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const first = loadDemoOperatorIdentity();
  assert.ok(first);
  const second = loadDemoOperatorIdentity();
  assert.ok(second);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.publicKeyB64, first.publicKeyB64);
  assert.equal(fs.existsSync(path.join(dataDir, "demo-operator.json")), true);
});

test("private key must match a configured public trust root", (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(-32).toString("base64");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const other = crypto.generateKeyPairSync("ed25519").publicKey;
  const otherSpki = other.export({ format: "der", type: "spki" }) as Buffer;
  const otherPub = otherSpki.subarray(-32).toString("base64");

  withEnv(t, {
    IMMUNE_DEMO_OPERATOR: undefined,
    IMMUNE_ACTION_PRIVATE_KEY: pkcs8.toString("base64"),
    IMMUNE_ACTION_PUBLIC_KEY: otherPub,
  });
  assert.throws(
    () => loadDemoOperatorIdentity(),
    /does not match IMMUNE_ACTION_PUBLIC_KEY/,
  );
  process.env.IMMUNE_ACTION_PUBLIC_KEY = pub;
  const identity = loadDemoOperatorIdentity();
  assert.ok(identity);
  assert.equal(identity.publicKeyB64, pub);
  assert.equal(identity.demo, false);
});
