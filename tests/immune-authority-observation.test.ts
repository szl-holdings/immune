import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthorityHead, parseDiscovery } from "../server/tools/immune-authority-action";

const HF_REVISION = "a".repeat(40);
// Supplied parser fixtures only: no real signer, trust proof, or provider claim.
const TRUST = {
  keyId: "b".repeat(16), trustEpoch: "c".repeat(32),
} as Parameters<typeof parseAuthorityHead>[1];

function liveFixture(revision = 0): any {
  return {
    revision, authorityReceiptCount: revision,
    authorityReceiptHash: revision === 0 ? null : "d".repeat(64),
    evidenceState: revision === 0 ? "UNAVAILABLE" : "STALE",
    authority: {
      enabled: true, version: "immune.action.v2", audience: "hf-space:SZLHOLDINGS/immune",
      source: { repository: "szl-holdings/immune" },
      deployment: { space: "SZLHOLDINGS/immune", revision: HF_REVISION },
      externalOperator: true, ...TRUST, instanceId: "e".repeat(32),
      durability: { required: true, verified: true, path: "/data/immune" },
    },
  };
}

function discoveryFixture(): any {
  return {
    schema: "szl.immune-authority-discovery/v1",
    sourceRevision: "f".repeat(40), hfRevision: HF_REVISION,
    deployRunId: 42, deployRunAttempt: 1, manifestSha256: "1".repeat(64),
    outputPaths: ["hf-deploy-manifest.json"],
    volume: { type: "bucket", source: "SZLHOLDINGS/immune-authority", mountPath: "/data", readOnly: false },
    trust: { ...TRUST, publicKeySha256: "2".repeat(64) },
    authority: parseAuthorityHead(liveFixture(), TRUST, HF_REVISION),
    ledger: {
      ok: true, count: 1, first_bad_seq: null,
      durability: { required: true, verified: true, path: "/data/immune/evidence", mount_path: "/data" },
    },
  };
}

test("live head preserves typed genesis and non-genesis bindings", () => {
  for (const revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const live = liveFixture(revision);
    const actual = parseAuthorityHead(live, TRUST, HF_REVISION);
    assert.equal(actual.revision, revision);
    assert.equal(actual.receiptHash, revision === 0 ? "GENESIS" : live.authorityReceiptHash);
    assert.equal(actual.instanceId, live.authority.instanceId);
    assert.equal(actual.durabilityPath, "/data/immune");
  }
  const discovery = discoveryFixture();
  assert.deepEqual(parseDiscovery(discovery), discovery);
});

for (const field of ["revision", "authorityReceiptCount"]) {
  test(`live head rejects coercible and invalid ${field}`, () => {
    for (const invalid of ["0", "1", [0], [1], null, false, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 2]) {
      const live = liveFixture(1);
      live[field] = invalid;
      assert.throws(() => parseAuthorityHead(live, TRUST, HF_REVISION), /receipt head/);
    }
  });
}

test("live instance and non-genesis receipt hash must be strings", () => {
  for (const field of ["instanceId", "authorityReceiptHash"]) {
    for (const shape of ["array", "null", "object", "number", "boolean"]) {
      const live = liveFixture(1);
      const target = field === "instanceId" ? live.authority : live;
      const original = target[field];
      target[field] = shape === "array" ? [original] : shape === "null" ? null
        : shape === "object" ? { value: original } : shape === "number" ? 42 : true;
      assert.throws(() => parseAuthorityHead(live, TRUST, HF_REVISION), /identity|receipt head/);
    }
  }
});

test("live genesis requires raw null and never a supplied GENESIS label", () => {
  for (const head of ["GENESIS", "", [null], "d".repeat(64), undefined]) {
    const live = liveFixture();
    live.authorityReceiptHash = head;
    assert.throws(() => parseAuthorityHead(live, TRUST, HF_REVISION), /receipt head/);
  }
});

for (const authorityPath of [
  "/data/immune-other", "/data/immune/authority.sqlite", "/data/immune/",
  "/data/immune/../immune", "/data//immune", "/data/immune/.",
  "/data/immune\\", "/data/immune\u0000", "/data/immune\n",
  ["/data/immune"], null, undefined,
]) {
  test(`live and saved authority paths require exact directory: ${JSON.stringify(authorityPath)}`, () => {
    const live = liveFixture();
    live.authority.durability.path = authorityPath;
    assert.throws(() => parseAuthorityHead(live, TRUST, HF_REVISION), /durability/);
    const discovery = discoveryFixture();
    discovery.authority.durabilityPath = authorityPath;
    assert.throws(() => parseDiscovery(discovery), /discovery is malformed/);
  });
}
