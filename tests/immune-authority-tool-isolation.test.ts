import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildReadinessContract } from "../server/readiness";
import { AuthorityStore, publicAuthoritySnapshot } from "../server/routes/immune/state";
import {
  ACTION_AUDIENCE,
  ACTION_VERSION,
  REPOSITORY,
  SPACE,
  assertExactAppliedAction,
  assertVerifiedEvidenceLedger,
  canonicalBytes,
  expectedActionResult,
  parseSignedEnvelope,
  type ImmuneMode,
  type SignedActionEnvelope,
} from "../server/tools/immune-authority-contract";

const SOURCE_REVISION = "a".repeat(40);
const HF_REVISION = "b".repeat(40);
const INSTANCE_ID = "c".repeat(32);
const TRUST_EPOCH = "d".repeat(32);
const KEY_ID = "e".repeat(16);
const PREVIOUS_HASH = "f".repeat(64);

function independentlyHashReceipt(receipt: Record<string, unknown>): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [
        key, canonicalize((value as Record<string, unknown>)[key]),
      ]));
    }
    return value;
  };
  const { receiptHash: _receiptHash, envelope: _envelope, ...hashed } = receipt;
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(hashed)))
    .digest("hex");
}

function envelope(mode: ImmuneMode): SignedActionEnvelope {
  return {
    version: ACTION_VERSION,
    requestId: `owner-${mode.toLowerCase()}-request-0001`,
    trustEpoch: TRUST_EPOCH,
    authorityInstanceId: INSTANCE_ID,
    expectedRevision: 3,
    expectedReceiptHash: PREVIOUS_HASH,
    issuedAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-30T12:04:00.000Z",
    validUntil:
      mode === "PASS"
        ? "2026-08-30T12:15:00.000Z"
        : "2026-08-31T12:00:00.000Z",
    actor: "github:stephenlutar2-hash",
    keyId: KEY_ID,
    audience: ACTION_AUDIENCE,
    source: { repository: REPOSITORY, revision: SOURCE_REVISION },
    deployment: { space: SPACE, revision: HF_REVISION },
    action: {
      type: "SET_MODE",
      mode,
      ...(mode === "DEADMAN" ? { tripwire: "T07" } : {}),
    },
    signature: Buffer.alloc(64).toString("base64"),
  };
}

function appliedFixture(subject: SignedActionEnvelope) {
  const result = expectedActionResult(subject);
  const receipt = {
    seq: 4,
    requestId: subject.requestId,
    envelopeDigest: crypto
      .createHash("sha256")
      .update(
        Buffer.from(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(subject)
                .filter(([key]) => key !== "signature")
                .sort(([left], [right]) => left.localeCompare(right)),
            ),
          ),
        ),
      )
      .digest("hex"),
    previousHash: PREVIOUS_HASH,
    receiptHash: "",
    issuedAt: subject.issuedAt,
    appliedAt: "2026-08-30T12:00:01.000Z",
    actor: subject.actor,
    action: subject.action,
    result,
    envelope: subject,
  };
  // Use the production helper's canonical digest rather than object insertion
  // order. This assignment is isolated to the fixture.
  const unsigned = { ...subject } as Record<string, unknown>;
  delete unsigned.signature;
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            canonicalize((value as Record<string, unknown>)[key]),
          ]),
      );
    }
    return value;
  };
  receipt.envelopeDigest = crypto
    .createHash("sha256")
    .update(Buffer.from(JSON.stringify(canonicalize(unsigned))))
    .digest("hex");
  receipt.receiptHash = independentlyHashReceipt(receipt);
  const state = {
    ...result,
    evidenceState: "VERIFIED",
    reason: "signed action and receipt chain verified",
    validUntil: subject.validUntil,
    authorityReceiptCount: receipt.seq,
    authorityReceiptHash: receipt.receiptHash,
    durableState: result,
    tripwireState: {
      evidenceState: "VERIFIED",
      ...result,
      reason: "signed action and receipt chain verified",
      validUntil: subject.validUntil,
    },
    authority: {
      enabled: true,
      version: ACTION_VERSION,
      keyId: KEY_ID,
      trustEpoch: TRUST_EPOCH,
      instanceId: INSTANCE_ID,
      audience: ACTION_AUDIENCE,
      source: { repository: REPOSITORY, revision: SOURCE_REVISION },
      deployment: { space: SPACE, revision: HF_REVISION },
      durability: {
        required: true,
        verified: true,
        path: "/data/immune",
      },
      externalOperator: true,
    },
  };
  const runtimeDigest = "2".repeat(64);
  const readiness = buildReadinessContract({
    source: {
      schema: "szl.source-attestation/v2",
      state: "OBSERVED_RUNTIME_HASH_MATCH",
      alignment: "OBSERVED_RUNTIME_HASH_MATCH",
      source_repository: REPOSITORY,
      source_revision: SOURCE_REVISION,
      source_ref: "refs/heads/main",
      destination: SPACE,
      workflow: null,
      manifest_schema: "szl.hf-deploy-manifest/v2",
      artifact_integrity: { status: "MATCH", checked: 4, failures: [] },
      expected_huggingface_revision: HF_REVISION,
      observed_huggingface_revision: HF_REVISION,
      claims: {
        whole_repository_parity: false,
        runtime_whitelist_hash_match: true,
        huggingface_revision_match: true,
        github_actions_provenance_verified: false,
        cryptographic_release_receipt: false,
      },
      relation: "declared-github-source-with-runtime-hash-match",
      limits: [],
      alignment_state: "OBSERVED_RUNTIME_HASH_MATCH",
      source: {
        repository: REPOSITORY,
        commit: SOURCE_REVISION,
        ref: "refs/heads/main",
      },
      deployment: { hf_space: SPACE, hf_revision: HF_REVISION },
    },
    build: {
      schema: "szl.build-info/v2",
      state: "OBSERVED_HASH_MATCH",
      source_repository: REPOSITORY,
      source_revision: SOURCE_REVISION,
      expected_huggingface_revision: HF_REVISION,
      observed_huggingface_revision: HF_REVISION,
      artifact_count: 4,
      runtime_hash_match: true,
      receipt_minted: false,
      build: {
        state: "OBSERVED_HASH_MATCH",
        revision: SOURCE_REVISION,
        artifact_count: 4,
        runtime_hash_match: true,
        receipt_minted: false,
      },
    },
    runtime: {
      state: "MATCH",
      available: true,
      reason: null,
      source_repository: REPOSITORY,
      source_revision: SOURCE_REVISION,
      deployment_manifest_sha256: runtimeDigest,
      artifact_set_sha256: runtimeDigest,
      immune_server_sha256: runtimeDigest,
      public_index_sha256: runtimeDigest,
    },
    ledger: { ok: true, count: 1, issues: [], firstBadSeq: null },
    ledgerDurability: {
      required: true, verified: true, path: "/data/immune/evidence",
      mount_path: "/data", reason: "verified test fixture",
    },
    authority: state,
  });
  return { receipt, state, readiness };
}

test("exact postcondition verification distinguishes PASS, reject, and deadman", () => {
  for (const mode of ["PASS", "SENTRA_REJECT", "DEADMAN"] as const) {
    const subject = envelope(mode);
    const fixture = appliedFixture(subject);
    assert.doesNotThrow(() =>
      assertExactAppliedAction(
        subject,
        fixture.receipt,
        fixture.state,
        fixture.readiness,
      ),
    );
  }
});

test("wrong action, CAS sequence, and tripwire state fail closed", () => {
  const reject = envelope("SENTRA_REJECT");
  const deadman = appliedFixture(envelope("DEADMAN"));
  assert.throws(
    () =>
      assertExactAppliedAction(
        reject,
        deadman.receipt,
        deadman.state,
        deadman.readiness,
      ),
    /receipt does not exactly bind/,
  );

  const sequence = appliedFixture(reject);
  sequence.receipt.seq = 5;
  assert.throws(
    () =>
      assertExactAppliedAction(
        reject,
        sequence.receipt,
        sequence.state,
        sequence.readiness,
      ),
    /receipt does not exactly bind/,
  );

  const tripwire = appliedFixture(envelope("DEADMAN"));
  tripwire.state.tripwireState.tripwire = "T08";
  assert.throws(
    () =>
      assertExactAppliedAction(
        envelope("DEADMAN"),
        tripwire.receipt,
        tripwire.state,
        tripwire.readiness,
      ),
    /tripwire state/,
  );
});

test("durable evidence admission rejects missing or contradictory persistence before actions", () => {
  const good = appliedFixture(envelope("PASS")).readiness.ledger;
  assert.deepEqual(assertVerifiedEvidenceLedger(good), {
    ok: true, count: 1, first_bad_seq: null,
    durability: { required: true, verified: true,
      path: "/data/immune/evidence", mount_path: "/data" },
  });
  const invalid = [
    undefined, null, [], {}, { ...good, ok: false },
    { ...good, count: 0 }, { ...good, count: "1" },
    { ...good, count: 1.5 }, { ...good, first_bad_seq: 1 },
    { ...good, durability: undefined },
    ...[
      { required: false }, { required: "true" }, { verified: false },
      { verified: 1 }, { verified: "true" }, { path: "/app/data/immune" },
      { path: "/data/immune" }, { mount_path: "/tmp" },
    ].map((change) => ({ ...good, durability: { ...good.durability, ...change } })),
  ];
  for (const ledger of invalid) {
    assert.throws(() => assertVerifiedEvidenceLedger(ledger), /evidence ledger/);
    const fixture = appliedFixture(envelope("PASS"));
    // All echoed readiness booleans remain green: independently require the
    // evidence observation, not a claimed READY status.
    (fixture.readiness as any).ledger = ledger;
    assert.throws(() => assertExactAppliedAction(envelope("PASS"),
      fixture.receipt, fixture.state, fixture.readiness), /evidence ledger/);
  }
});

test("receipt digest is independently verified even when every runtime echo agrees", () => {
  const subject = envelope("PASS");
  const fixture = appliedFixture(subject);
  const incorrectHash = "9".repeat(64);
  fixture.receipt.receiptHash = incorrectHash;
  fixture.state.authorityReceiptHash = incorrectHash;
  fixture.readiness.authority.receipt_hash = incorrectHash;
  assert.throws(() => assertExactAppliedAction(
    subject, fixture.receipt, fixture.state, fixture.readiness,
  ), /receipt does not exactly bind/);

  const alteredTime = appliedFixture(subject);
  alteredTime.receipt.appliedAt = "2026-08-30T12:00:02.000Z";
  assert.throws(() => assertExactAppliedAction(
    subject, alteredTime.receipt, alteredTime.state, alteredTime.readiness,
  ), /receipt does not exactly bind/);
});

test("receipt actor, issued time, and admission bounds cannot be rehashed into valid evidence", () => {
  const subject = envelope("PASS");
  for (const patch of [
    { actor: "github:different-operator" },
    { issuedAt: "2026-08-30T12:00:01.000Z" },
    { appliedAt: "2026-08-30T11:59:29.999Z" },
    { appliedAt: subject.expiresAt },
    { appliedAt: "2026-08-30T12:04:00.001Z" },
    { appliedAt: "not-a-time" },
    { appliedAt: "2026-08-30T12:00:01Z" },
    { appliedAt: null },
  ]) {
    const fixture = appliedFixture(subject);
    Object.assign(fixture.receipt, patch);
    fixture.receipt.receiptHash = independentlyHashReceipt(fixture.receipt);
    fixture.state.authorityReceiptHash = fixture.receipt.receiptHash;
    fixture.readiness.authority.receipt_hash = fixture.receipt.receiptHash;
    assert.throws(() => assertExactAppliedAction(
      subject, fixture.receipt, fixture.state, fixture.readiness,
    ), /actor or admission time/, JSON.stringify(patch));
  }
});

test("receipt schema is exact and the full allowed clock-skew admission window verifies", () => {
  const subject = envelope("SENTRA_REJECT");
  for (const appliedAt of [
    "2026-08-30T11:59:30.000Z",
    "2026-08-30T12:03:59.999Z",
  ]) {
    const fixture = appliedFixture(subject);
    fixture.receipt.appliedAt = appliedAt;
    fixture.receipt.receiptHash = independentlyHashReceipt(fixture.receipt);
    fixture.state.authorityReceiptHash = fixture.receipt.receiptHash;
    fixture.readiness.authority.receipt_hash = fixture.receipt.receiptHash;
    assert.doesNotThrow(() => assertExactAppliedAction(
      subject, fixture.receipt, fixture.state, fixture.readiness,
    ));
  }
  for (const field of ["actor", "appliedAt", "issuedAt", "receiptHash", "envelope"]) {
    const fixture = appliedFixture(subject);
    delete (fixture.receipt as Record<string, unknown>)[field];
    assert.throws(() => assertExactAppliedAction(
      subject, fixture.receipt, fixture.state, fixture.readiness,
    ), /missing required fields/);
  }
  const extra = appliedFixture(subject);
  Object.assign(extra.receipt, { unexpected: true });
  assert.throws(() => assertExactAppliedAction(
    subject, extra.receipt, extra.state, extra.readiness,
  ), /unknown fields/);
});

test("receipt verification accepts exact bytes emitted by AuthorityStore", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const rawPublic = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const keyId = crypto.createHash("sha256").update(rawPublic).digest("hex").slice(0, 16);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-receipt-proof-"));
  const store = new AuthorityStore({
    databasePath: path.join(temporary, "authority.sqlite"),
    publicKeyB64: rawPublic.toString("base64"),
    sourceRevision: SOURCE_REVISION,
    deploymentRevision: HF_REVISION,
    trustEpoch: TRUST_EPOCH,
    requireDurableStorage: true,
    durabilityCheck: () => true,
    now: () => new Date("2026-08-30T12:00:01.000Z"),
  });
  try {
    const unsigned = {
      ...envelope("PASS"),
      keyId,
      authorityInstanceId: store.snapshot().authority.instanceId!,
      expectedRevision: 0,
      expectedReceiptHash: "GENESIS",
    } as Record<string, unknown>;
    delete unsigned.signature;
    const subject = parseSignedEnvelope({
      ...unsigned,
      signature: crypto.sign(null, canonicalBytes(unsigned), pair.privateKey).toString("base64"),
    });
    const state = publicAuthoritySnapshot(store.apply(subject));
    const fixture = appliedFixture(subject);
    const receipt = store.receipt(subject.requestId, fixture.receipt.envelopeDigest);
    assert.ok(receipt);
    const readiness = fixture.readiness;
    readiness.authority.key_id = keyId;
    readiness.authority.receipt_count = receipt.seq;
    readiness.authority.receipt_hash = receipt.receiptHash;
    assert.doesNotThrow(() => assertExactAppliedAction(subject, receipt, state, readiness));
    assert.equal(receipt.receiptHash, independentlyHashReceipt({ ...receipt }));
  } finally {
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("offline signer accepts only key and public pin environment variables", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKeyB64 = (
    pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  ).toString("base64");
  const publicKeyB64 = (
    pair.publicKey.export({ format: "der", type: "spki" }) as Buffer
  )
    .subarray(-32)
    .toString("base64");
  const keyId = crypto
    .createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64"))
    .digest("hex")
    .slice(0, 16);
  const now = Date.now();
  const intent = {
    ...envelope("PASS"),
    keyId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 4 * 60_000).toISOString(),
    validUntil: new Date(now + 15 * 60_000).toISOString(),
  } as Record<string, unknown>;
  delete intent.signature;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-signer-"));
  try {
    const intentPath = path.join(temporary, "intent.json");
    const envelopePath = path.join(temporary, "envelope.json");
    fs.writeFileSync(intentPath, JSON.stringify(intent), "utf8");
    const signer = path.resolve(
      import.meta.dirname,
      "../server/tools/immune-authority-signer.mjs",
    );
    const clean = spawnSync(
      process.execPath,
      [signer, intentPath, envelopePath],
      {
        env: {
          IMMUNE_ACTION_SIGNING_PKCS8_B64: privateKeyB64,
          IMMUNE_ACTION_PUBLIC_KEY: publicKeyB64,
        },
        encoding: "utf8",
      },
    );
    assert.equal(clean.status, 0, clean.stderr);
    assert.doesNotThrow(() =>
      parseSignedEnvelope(JSON.parse(fs.readFileSync(envelopePath, "utf8"))),
    );

    const prohibited = spawnSync(
      process.execPath,
      [signer, intentPath, path.join(temporary, "prohibited.json")],
      {
        env: {
          IMMUNE_ACTION_SIGNING_PKCS8_B64: privateKeyB64,
          IMMUNE_ACTION_PUBLIC_KEY: publicKeyB64,
          GITHUB_TOKEN: "must-not-reach-signer",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(prohibited.status, 0);
    assert.match(prohibited.stderr, /prohibited environment variable: GITHUB_TOKEN/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("network authority tool has no action signing capability", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const network = fs.readFileSync(
    path.join(root, "server/tools/immune-authority-action.ts"),
    "utf8",
  );
  const signer = fs.readFileSync(
    path.join(root, "server/tools/immune-authority-signer.mjs"),
    "utf8",
  );
  assert.doesNotMatch(network, /IMMUNE_ACTION_SIGNING_PKCS8_B64/);
  assert.doesNotMatch(network, /createPrivateKey|loadExternalOperatorIdentity/);
  assert.doesNotMatch(signer, /\bfetch\b|node:https|node:http|GITHUB_TOKEN|HF_TOKEN/);
  assert.match(signer, /Object\.keys\(process\.env\)/);
  const observe = network.slice(network.indexOf("async function observe("),
    network.indexOf("function parseDiscovery("));
  assert.match(observe, /assertVerifiedEvidenceLedger\(readiness\.ledger\)/);
  const submit = network.slice(network.indexOf("async function submit("));
  assert.ok(submit.indexOf("await observe(") >= 0);
  assert.ok(submit.indexOf("await observe(") < submit.indexOf('method: "POST"'));
});
