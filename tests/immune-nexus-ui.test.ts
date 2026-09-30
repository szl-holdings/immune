import assert from "node:assert/strict";
import test from "node:test";
import { canExecute, matchingReadiness, verifiedReadiness } from "../frontend/public/nexus-readiness.js";

function ready() {
  return {
    schema: "szl.immune-readiness/v1", status: "READY", ready: true,
    runtime_ready: true, read_ready: true, authority_ready: true, write_ready: true,
    blockers: [], source: { repository: "szl-holdings/immune", revision: "a".repeat(40),
      build_revision: "a".repeat(40), alignment_state: "OBSERVED_RUNTIME_HASH_MATCH",
      manifest_schema: "szl.hf-deploy-manifest/v2" },
    build: { state: "OBSERVED_HASH_MATCH", artifact_count: 7, runtime_hash_match: true,
      artifact_set_algorithm: "sha256(json(sorted[path,sha256]))",
      deployment_manifest_sha256: "d".repeat(64), artifact_set_sha256: "e".repeat(64) },
    runtime: { immune_server_sha256: "f".repeat(64), public_index_sha256: "0".repeat(64),
      artifact_integrity: { status: "MATCH", checked: 7, failures: [] } },
    ledger: { ok: true, count: 1, first_bad_seq: null, durability: { required: true, verified: true,
      path: "/data/immune/evidence", mount_path: "/data", reason: "existing durable evidence observed" } }, authority: {
      enabled: true, version: "immune.action.v2", audience: "hf-space:SZLHOLDINGS/immune",
      external_operator: true, evidence_state: "VERIFIED", source_revision: "a".repeat(40),
      key_id: "1234567890abcdef", receipt_count: 1, receipt_hash: "c".repeat(64),
      deployment: { space: "SZLHOLDINGS/immune", revision: "b".repeat(40) },
      durability: { required: true, verified: true, path: "/data/immune" },
    },
  };
}

test("NEXUS execution requires independently matching whole-system readiness", () => {
  assert.equal(matchingReadiness(ready(), {state: "EXECUTABLE", immuneReadiness: ready()}), true);
  for (const flag of ["ready", "runtime_ready", "read_ready", "authority_ready", "write_ready"]) {
    const bad = { ...ready(), [flag]: false };
    assert.equal(matchingReadiness(bad, {state: "EXECUTABLE", immuneReadiness: ready()}), false, flag);
    assert.equal(matchingReadiness(ready(), {state: "EXECUTABLE", immuneReadiness: bad}), false, flag);
  }
  for (const value of [null, {}, {write_ready: true}, {...ready(), status: "READ_ONLY"}]) {
    assert.equal(matchingReadiness(value, {state: "EXECUTABLE", immuneReadiness: ready()}), false);
  }
});

test("NEXUS UI refuses drift, legacy authority, integrity failures and incomplete evidence", () => {
  const mutations = [
    (v) => {v.authority.receipt_hash = "d".repeat(64)},
    (v) => {v.authority.deployment.revision = "e".repeat(40)},
    (v) => {v.authority.key_id = "fedcba9876543210"},
    (v) => {v.authority.receipt_count = 2},
    (v) => {v.build.deployment_manifest_sha256 = "9".repeat(64)},
    (v) => {v.build.artifact_set_sha256 = "9".repeat(64)},
    (v) => {v.runtime.immune_server_sha256 = "9".repeat(64)},
    (v) => {v.runtime.public_index_sha256 = "9".repeat(64)},
    (v) => {v.authority.evidence_state = "EXPIRED"},
    (v) => {v.authority.version = "immune.action.v1"},
    (v) => {v.authority.durability.verified = false},
    (v) => {v.runtime.artifact_integrity.status = "MISMATCH"},
    (v) => {v.ledger.ok = false},
    (v) => {v.ledger.durability.verified = false},
    (v) => {v.source.build_revision = null},
    (v) => {v.blockers = ["ACTION_AUTHORITY_MODE_DEADMAN"]},
    (v) => {v.blockers = ["ACTION_AUTHORITY_MODE_SENTRA_REJECT"]},
  ];
  for (const mutate of mutations) {
    const invalid = ready(); mutate(invalid);
    assert.equal(matchingReadiness(ready(), {state: "EXECUTABLE", immuneReadiness: invalid}), false);
  }
  assert.equal(matchingReadiness(ready(), {state: "READ_ONLY", immuneReadiness: ready()}), false);
});

test("NEXUS rejects the same contradictory evidence in both independent responses", () => {
  const mutations = [
    ["missing source manifest schema", v => {delete v.source.manifest_schema}],
    ["legacy source manifest schema", v => {v.source.manifest_schema = "szl.hf-deploy-manifest/v1"}],
    ["unverified build", v => {v.build.state = "UNVERIFIED"}],
    ["missing build digest", v => {delete v.build.deployment_manifest_sha256}],
    ["invalid artifact algorithm", v => {v.build.artifact_set_algorithm = "sha256"}],
    ["missing server digest", v => {delete v.runtime.immune_server_sha256}],
    ["missing UI digest", v => {delete v.runtime.public_index_sha256}],
    ["unchecked runtime", v => {v.runtime.artifact_integrity.checked = 0}],
    ["contradictory artifact count", v => {v.runtime.artifact_integrity.checked = 6}],
    ["unreported integrity failures", v => {delete v.runtime.artifact_integrity.failures}],
    ["non-array integrity failures", v => {v.runtime.artifact_integrity.failures = {length: 0}}],
    ["runtime failure with MATCH label", v => {v.runtime.artifact_integrity.failures = ["immune-server.js"]}],
    ["missing first bad sequence", v => {delete v.ledger.first_bad_seq}],
    ["broken ledger with ok label", v => {v.ledger.first_bad_seq = 1}],
    ["ephemeral authority path", v => {v.authority.durability.path = "/tmp/immune"}],
    ["missing authority path", v => {delete v.authority.durability.path}],
    ["ephemeral evidence path", v => {v.ledger.durability.path = "/app/data/immune"}],
    ["wrong evidence mount", v => {v.ledger.durability.mount_path = "/"}],
    ["missing durability observation", v => {delete v.ledger.durability.reason}],
    ["empty durability observation", v => {v.ledger.durability.reason = " "}],
    ["invalid key ID", v => {v.authority.key_id = "1234567890abcdeF"}],
    ["missing key ID", v => {delete v.authority.key_id}],
    ["deadman blocker", v => {v.blockers = ["ACTION_AUTHORITY_DEADMAN"]}],
    ["rejected mode blocker", v => {v.blockers = ["ACTION_AUTHORITY_SENTRA_REJECT"]}],
    ["failed authority evidence", v => {v.authority.evidence_state = "FAILED"}],
    ["expired authority evidence", v => {v.authority.evidence_state = "STALE"}],
    ["non-boolean durability", v => {v.authority.durability.verified = "true"}],
  ];
  for (const [label, mutate] of mutations) {
    const invalid = ready(); mutate(invalid);
    assert.equal(verifiedReadiness(invalid), false, label);
    assert.equal(matchingReadiness(invalid, {state: "EXECUTABLE", immuneReadiness: invalid}), false, label);
  }
});

test("NEXUS requires positive safe integer counts without numeric coercion", () => {
  for (const invalidCount of [undefined, null, "1", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["ledger", "receipt", "artifact", "checked"]) {
      const invalid = ready();
      if (field === "ledger") invalid.ledger.count = invalidCount;
      if (field === "receipt") invalid.authority.receipt_count = invalidCount;
      if (field === "artifact") invalid.build.artifact_count = invalidCount;
      if (field === "checked") invalid.runtime.artifact_integrity.checked = invalidCount;
      assert.equal(matchingReadiness(invalid, {state: "EXECUTABLE", immuneReadiness: invalid}), false, `${field}:${String(invalidCount)}`);
    }
  }
});

test("NEXUS revisions, hashes and key IDs must be primitive canonical strings", () => {
  const paths = [
    ["source", "revision"], ["source", "build_revision"], ["authority", "source_revision"],
    ["authority", "key_id"], ["authority", "receipt_hash"],
    ["build", "deployment_manifest_sha256"], ["build", "artifact_set_sha256"],
    ["runtime", "immune_server_sha256"], ["runtime", "public_index_sha256"],
    ["authority", "deployment", "revision"],
  ];
  for (const keys of paths) {
    for (const wrap of [value => [value], value => new String(value), value => ({toString: () => value})]) {
      const invalid = ready();
      let target = invalid;
      for (const key of keys.slice(0, -1)) target = target[key];
      const key = keys.at(-1);
      target[key] = wrap(target[key]);
      assert.equal(matchingReadiness(invalid, {state: "EXECUTABLE", immuneReadiness: invalid}), false, keys.join("."));
    }
  }
});

test("NEXUS execution is disabled when stale, future-dated, busy, hidden or offline", () => {
  const state = {writeReady: true, observedAt: 1000, busy: false};
  assert.equal(canExecute(state, 1001), true);
  assert.equal(canExecute(state, 11000), false);
  assert.equal(canExecute(state, 999), false);
  assert.equal(canExecute({...state, observedAt: NaN}, 1001), false);
  assert.equal(canExecute({...state, observedAt: -1}, 1001), false);
  assert.equal(canExecute({...state, busy: true}, 1001), false);
  assert.equal(canExecute({...state, writeReady: false}, 1001), false);
  assert.equal(canExecute(state, 1001, false, true), false);
  assert.equal(canExecute(state, 1001, true, false), false);
  assert.equal(canExecute(state, Infinity), false);
  assert.equal(canExecute(state, 1001, "true", true), false);
  assert.equal(canExecute(state, 1001, true, "true"), false);
  assert.equal(canExecute({...state, busy: "false"}, 1001), false);
  assert.equal(canExecute(null, 1001), false);
});
