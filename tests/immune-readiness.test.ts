import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observeAuthorityStorage } from "../server/routes/immune/state";
import { ledgerDurability } from "../server/routes/immune/ledger";
import {
  bindRuntimeStaticDir,
  getRuntimeHashBinding,
} from "../server/source-attestation";
import {
  agentStatus,
  type AgentStatusDependencies,
} from "../server/routes/immune/agent";
import {
  buildReadinessContract,
  readinessHttpResult,
  readinessStatus,
  type ReadinessDependencies,
  type ReadinessInputs,
} from "../server/readiness";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);
const DEPLOYMENT_REVISION = "c".repeat(40);

function observedLedgerDurability(): NonNullable<ReadinessInputs["ledgerDurability"]> {
  return {
    required: true,
    verified: true,
    path: "/data/immune/evidence",
    mount_path: "/data",
    reason: "existing evidence files observed writable and fsync-capable; restart proof remains separate",
  };
}

function authorityMetadata(enabled: boolean, durabilityVerified = enabled) {
  return {
    enabled,
    version: "immune.action.v2" as const,
    keyId: enabled ? "0123456789abcdef" : null,
    trustEpoch: enabled ? "1".repeat(32) : null,
    instanceId: enabled ? "2".repeat(32) : null,
    audience: "hf-space:SZLHOLDINGS/immune" as const,
    source: {
      repository: "szl-holdings/immune" as const,
      revision: REVISION,
    },
    deployment: {
      space: "SZLHOLDINGS/immune" as const,
      revision: DEPLOYMENT_REVISION,
    },
    durability: {
      required: true,
      verified: durabilityVerified,
      path: "/data/immune",
    },
    externalOperator: true as const,
  };
}

function inputs(): ReadinessInputs {
  return {
    source: {
      schema: "szl.source-attestation/v2",
      state: "OBSERVED_RUNTIME_HASH_MATCH",
      alignment: "OBSERVED_RUNTIME_HASH_MATCH",
      source_repository: "szl-holdings/immune",
      source_revision: REVISION,
      source_ref: "refs/heads/main",
      destination: "SZLHOLDINGS/immune",
      workflow: null,
      manifest_schema: "szl.hf-deploy-manifest/v2",
      artifact_integrity: { status: "MATCH", checked: 7, failures: [] },
      expected_huggingface_revision: DEPLOYMENT_REVISION,
      observed_huggingface_revision: DEPLOYMENT_REVISION,
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
        repository: "szl-holdings/immune",
        commit: REVISION,
        ref: "refs/heads/main",
      },
      deployment: {
        hf_space: "SZLHOLDINGS/immune",
        hf_revision: DEPLOYMENT_REVISION,
      },
    },
    build: {
      schema: "szl.build-info/v2",
      state: "OBSERVED_HASH_MATCH",
      source_repository: "szl-holdings/immune",
      source_revision: REVISION,
      expected_huggingface_revision: null,
      observed_huggingface_revision: null,
      artifact_count: 7,
      runtime_hash_match: true,
      receipt_minted: false,
      build: {
        state: "OBSERVED_HASH_MATCH",
        revision: REVISION,
        artifact_count: 7,
        runtime_hash_match: true,
        receipt_minted: false,
      },
    },
    runtime: {
      state: "MATCH",
      available: true,
      reason: null,
      source_repository: "szl-holdings/immune",
      source_revision: REVISION,
      deployment_manifest_sha256: DIGEST,
      artifact_set_sha256: DIGEST,
      immune_server_sha256: DIGEST,
      public_index_sha256: DIGEST,
    },
    ledger: { ok: true, count: 3, issues: [], firstBadSeq: null },
    ledgerDurability: observedLedgerDurability(),
    authority: {
      mode: "SENTRA_REJECT",
      tripwire: null,
      deadman: false,
      updatedAt: null,
      requestId: null,
      revision: 0,
      evidenceState: "UNAVAILABLE",
      reason: "signed action trust root is not configured",
      validUntil: null,
      authorityReceiptCount: 0,
      authorityReceiptHash: null,
      authority: authorityMetadata(false),
    },
  };
}

test("verified runtime remains honestly read-only without an action trust root", () => {
  const readiness = buildReadinessContract(inputs());
  assert.equal(readiness.status, "READ_ONLY");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.runtime_ready, true);
  assert.equal(readiness.read_ready, true);
  assert.equal(readiness.authority_ready, false);
  assert.equal(readiness.write_ready, false);
  assert.deepEqual(readiness.blockers, ["ACTION_TRUST_ROOT_UNCONFIGURED"]);
  assert.deepEqual(readiness.authority.durability, {
    required: true,
    verified: false,
    path: "/data/immune",
  });
  assert.equal(readinessHttpResult(dependencies()).statusCode, 503);
  assert.equal(readiness.source.revision, REVISION);
  assert.equal(readiness.source.build_revision, REVISION);
  assert.equal(readiness.build.deployment_manifest_sha256, DIGEST);
  assert.equal(
    readiness.build.artifact_set_algorithm,
    "sha256(json(sorted[path,sha256]))",
  );
  assert.equal(readiness.runtime.immune_server_sha256, DIGEST);
  assert.equal(readiness.ledger.ok, true);
});

test("source drift and receipt corruption independently fail runtime readiness", () => {
  const drift = inputs();
  drift.build.build.revision = "c".repeat(40);
  let readiness = buildReadinessContract(drift);
  assert.equal(readiness.status, "NOT_READY");
  assert.equal(readiness.runtime_ready, false);
  assert.ok(readiness.blockers.includes("SOURCE_BUILD_BINDING_UNVERIFIED"));

  const missingDeployment = inputs();
  missingDeployment.source.state = "REVISION_UNAVAILABLE";
  missingDeployment.source.alignment = "REVISION_UNAVAILABLE";
  missingDeployment.source.alignment_state = "REVISION_UNAVAILABLE";
  missingDeployment.source.expected_huggingface_revision = null;
  missingDeployment.source.observed_huggingface_revision = null;
  missingDeployment.source.claims.huggingface_revision_match = false;
  missingDeployment.source.deployment.hf_revision = null;
  readiness = buildReadinessContract(missingDeployment);
  assert.equal(readiness.status, "NOT_READY");
  assert.equal(readiness.runtime_ready, false);
  assert.ok(
    readiness.blockers.includes("DEPLOYMENT_REVISION_BINDING_UNVERIFIED"),
  );

  const corrupt = inputs();
  corrupt.ledger = {
    ok: false,
    count: 3,
    issues: [{ seq: 2, kind: "bad_hash", detail: "hash mismatch" }],
    firstBadSeq: 2,
  };
  readiness = buildReadinessContract(corrupt);
  assert.equal(readiness.status, "NOT_READY");
  assert.equal(readiness.read_ready, false);
  assert.equal(readiness.ledger.first_bad_seq, 2);
  assert.ok(readiness.blockers.includes("RECEIPT_LEDGER_INTEGRITY_FAILED"));

  const empty = inputs();
  empty.ledger = { ok: true, count: 0, issues: [], firstBadSeq: null };
  readiness = buildReadinessContract(empty);
  assert.equal(readiness.status, "NOT_READY");
  assert.equal(readiness.read_ready, false);
  assert.ok(readiness.blockers.includes("RECEIPT_LEDGER_EMPTY"));

  const missingRuntime = inputs();
  missingRuntime.runtime.available = false;
  missingRuntime.runtime.reason = "deployment manifest unavailable";
  readiness = buildReadinessContract(missingRuntime);
  assert.equal(readiness.status, "NOT_READY");
  assert.ok(readiness.blockers.includes("RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED"));
});

function dependencies(base = inputs()): ReadinessDependencies {
  return {
    sourceAttestation: () => base.source,
    buildInfo: () => base.build,
    runtimeHashBinding: () => base.runtime,
    verifyLedger: () => base.ledger,
    ledgerDurability: () => base.ledgerDurability!,
    getState: () => base.authority,
  };
}

test("every readiness dependency failure returns stable NOT_READY JSON and HTTP 503", () => {
  const cases: Array<[keyof ReadinessDependencies, string]> = [
    ["sourceAttestation", "SOURCE_ATTESTATION_UNAVAILABLE"],
    ["buildInfo", "BUILD_INFO_UNAVAILABLE"],
    ["runtimeHashBinding", "RUNTIME_HASH_BINDING_UNAVAILABLE"],
    ["verifyLedger", "RECEIPT_LEDGER_UNAVAILABLE"],
    ["getState", "ACTION_AUTHORITY_UNAVAILABLE"],
  ];

  for (const [dependency, blocker] of cases) {
    const failing = {
      ...dependencies(),
      [dependency]: () => {
        throw new Error(`${dependency} unavailable`);
      },
    } as ReadinessDependencies;
    const readiness = readinessStatus(failing);
    const http = readinessHttpResult(failing);
    assert.equal(readiness.schema, "szl.immune-readiness/v1", dependency);
    assert.equal(readiness.status, "NOT_READY", dependency);
    assert.equal(readiness.ready, false, dependency);
    assert.equal(readiness.runtime_ready, false, dependency);
    assert.equal(readiness.read_ready, false, dependency);
    assert.equal(readiness.authority_ready, false, dependency);
    assert.equal(readiness.write_ready, false, dependency);
    assert.deepEqual(readiness.blockers, [blocker], dependency);
    assert.equal(http.statusCode, 503, dependency);
    assert.deepEqual(http.body, readiness, dependency);
  }
});

function writeReadyInputs(): ReadinessInputs {
  const ready = inputs();
  ready.authority = {
    ...ready.authority,
    mode: "PASS",
    evidenceState: "VERIFIED",
    reason: "signed action and receipt chain verified",
    validUntil: "2026-08-01T19:00:00.000Z",
    updatedAt: "2026-08-01T18:59:00.000Z",
    requestId: "ready-authority-0001",
    revision: 1,
    authorityReceiptCount: 1,
    authorityReceiptHash: DIGEST,
    authority: authorityMetadata(true),
  };
  return ready;
}

test("full READY requires verified runtime, signed authority, and independently observed evidence durability", () => {
  const ready = writeReadyInputs();
  const readiness = buildReadinessContract(ready);
  assert.equal(readiness.status, "READY");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.authority_ready, true);
  assert.equal(readiness.write_ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.authority.durability, {
    required: true,
    verified: true,
    path: "/data/immune",
  });
  assert.equal(readinessHttpResult(dependencies(ready)).statusCode, 200);
  assert.deepEqual(readiness.ledger.durability, observedLedgerDurability());
});

// These deliberately contradictory observations exercise the evaluator boundary;
// they are not claims that the current live producers emit malformed snapshots.
type ReadinessContradiction = {
  name: string;
  mutate: (candidate: ReadinessInputs) => void;
  runtimeRemainsReady?: boolean;
};

function replaceObservation(target: object, field: string, value: unknown): void {
  Object.assign(target, { [field]: value });
}

const readinessContradictions: ReadinessContradiction[] = [
  { name: "MATCH with artifact failures", mutate: c => { c.source.artifact_integrity.failures = ["public/index.html: digest mismatch"]; } },
  { name: "MATCH without artifact failures observation", mutate: c => { replaceObservation(c.source.artifact_integrity, "failures", undefined); } },
  { name: "MATCH with non-array failures", mutate: c => { replaceObservation(c.source.artifact_integrity, "failures", ""); } },
  { name: "MATCH with zero checked artifacts", mutate: c => { c.source.artifact_integrity.checked = 0; } },
  { name: "MATCH with fractional checked artifacts", mutate: c => { c.source.artifact_integrity.checked = 0.5; } },
  { name: "MATCH with infinite checked artifacts", mutate: c => { c.source.artifact_integrity.checked = Infinity; } },
  { name: "MATCH with mismatched checked artifacts", mutate: c => { c.source.artifact_integrity.checked = 6; } },
  { name: "MATCH with unverified build state", mutate: c => { c.build.state = "UNVERIFIED"; } },
  { name: "MATCH with unverified nested build state", mutate: c => { c.build.build.state = "UNVERIFIED"; } },
  { name: "MATCH with zero build artifacts", mutate: c => { c.build.artifact_count = 0; } },
  { name: "MATCH with unsafe build artifact count", mutate: c => { c.build.artifact_count = Number.MAX_SAFE_INTEGER + 1; } },
  { name: "MATCH with nested build count mismatch", mutate: c => { c.build.build.artifact_count = 6; } },
  { name: "MATCH with nested build hash mismatch", mutate: c => { c.build.build.runtime_hash_match = false; } },
  { name: "available runtime with mismatched state", mutate: c => { c.runtime.state = "MISMATCH"; } },
  { name: "truthy non-boolean runtime availability", mutate: c => { replaceObservation(c.runtime, "available", "true"); } },
  { name: "truthy non-boolean source hash match", mutate: c => { replaceObservation(c.source.claims, "runtime_whitelist_hash_match", "true"); } },
  { name: "truthy non-boolean build hash match", mutate: c => { replaceObservation(c.build, "runtime_hash_match", 1); } },
  { name: "array-coerced runtime hash", mutate: c => { replaceObservation(c.runtime, "immune_server_sha256", [DIGEST]); } },
  { name: "ledger ok with a bad sequence", mutate: c => { c.ledger.firstBadSeq = 2; } },
  { name: "ledger ok with verification issues", mutate: c => { c.ledger.issues = [{ seq: 2, kind: "bad_hash", detail: "digest mismatch" }]; } },
  { name: "ledger ok without issues observation", mutate: c => { replaceObservation(c.ledger, "issues", undefined); } },
  { name: "ledger ok with non-array issues", mutate: c => { replaceObservation(c.ledger, "issues", ""); } },
  { name: "ledger ok without first bad sequence observation", mutate: c => { replaceObservation(c.ledger, "firstBadSeq", undefined); } },
  { name: "ledger ok with fractional count", mutate: c => { c.ledger.count = 0.5; } },
  { name: "ledger ok with infinite count", mutate: c => { c.ledger.count = Infinity; } },
  { name: "ledger ok with unsafe count", mutate: c => { c.ledger.count = Number.MAX_SAFE_INTEGER + 1; } },
  { name: "ledger ok with string count", mutate: c => { replaceObservation(c.ledger, "count", "3"); } },
  { name: "truthy non-boolean ledger ok", mutate: c => { replaceObservation(c.ledger, "ok", 1); } },
  { name: "authority without key id", mutate: c => { c.authority.authority.keyId = null; }, runtimeRemainsReady: true },
  { name: "authority with malformed key id", mutate: c => { c.authority.authority.keyId = "0123456789abcdeG"; }, runtimeRemainsReady: true },
  { name: "authority with array-coerced key id", mutate: c => { replaceObservation(c.authority.authority, "keyId", ["0123456789abcdef"]); }, runtimeRemainsReady: true },
  { name: "authority without receipts", mutate: c => { c.authority.authorityReceiptCount = 0; }, runtimeRemainsReady: true },
  { name: "authority with fractional receipt count", mutate: c => { c.authority.authorityReceiptCount = 0.5; }, runtimeRemainsReady: true },
  { name: "authority with infinite receipt count", mutate: c => { c.authority.authorityReceiptCount = Infinity; }, runtimeRemainsReady: true },
  { name: "authority with unsafe receipt count", mutate: c => { c.authority.authorityReceiptCount = Number.MAX_SAFE_INTEGER + 1; }, runtimeRemainsReady: true },
  { name: "authority with string receipt count", mutate: c => { replaceObservation(c.authority, "authorityReceiptCount", "1"); }, runtimeRemainsReady: true },
  { name: "authority without receipt hash", mutate: c => { c.authority.authorityReceiptHash = null; }, runtimeRemainsReady: true },
  { name: "authority with malformed receipt hash", mutate: c => { c.authority.authorityReceiptHash = "b".repeat(63); }, runtimeRemainsReady: true },
  { name: "authority with array-coerced receipt hash", mutate: c => { replaceObservation(c.authority, "authorityReceiptHash", [DIGEST]); }, runtimeRemainsReady: true },
  { name: "authority with missing durability path", mutate: c => { replaceObservation(c.authority.authority.durability, "path", null); }, runtimeRemainsReady: true },
  { name: "authority with ephemeral durability path", mutate: c => { c.authority.authority.durability.path = "/app/data/immune"; }, runtimeRemainsReady: true },
  { name: "authority with aliased durability path", mutate: c => { c.authority.authority.durability.path = "/data/immune/../immune"; }, runtimeRemainsReady: true },
  { name: "authority PASS with a tripwire", mutate: c => { c.authority.tripwire = "T01"; }, runtimeRemainsReady: true },
  { name: "authority PASS without tripwire observation", mutate: c => { replaceObservation(c.authority, "tripwire", undefined); }, runtimeRemainsReady: true },
  { name: "authority PASS without deadman observation", mutate: c => { replaceObservation(c.authority, "deadman", undefined); }, runtimeRemainsReady: true },
  { name: "authority PASS with numeric deadman flag", mutate: c => { replaceObservation(c.authority, "deadman", 0); }, runtimeRemainsReady: true },
  { name: "truthy non-boolean authority enabled", mutate: c => { replaceObservation(c.authority.authority, "enabled", "true"); }, runtimeRemainsReady: true },
];

for (const { name, mutate, runtimeRemainsReady = false } of readinessContradictions) {
  test(`readiness rejects inconsistent ${name}`, () => {
    const candidate = writeReadyInputs();
    mutate(candidate);
    const result = buildReadinessContract(candidate);
    assert.equal(result.ready, false, name);
    assert.equal(result.write_ready, false, name);
    assert.equal(result.runtime_ready, runtimeRemainsReady, name);
    assert.equal(result.read_ready, runtimeRemainsReady, name);
    assert.equal(result.status, runtimeRemainsReady ? "READ_ONLY" : "NOT_READY", name);
    assert.ok(result.blockers.length > 0, `${name}: explicit blocker is required`);
    assert.equal(readinessHttpResult(dependencies(candidate)).statusCode, 503, name);
  });
}

function assertDurabilityBlocksOnlyWrites(readiness: ReturnType<typeof buildReadinessContract>, label: string): void {
  assert.equal(readiness.status, "READ_ONLY", label);
  assert.equal(readiness.ready, false, label);
  assert.equal(readiness.write_ready, false, label);
  assert.equal(readiness.runtime_ready, true, label);
  assert.equal(readiness.read_ready, true, label);
  assert.equal(readiness.authority_ready, true, label);
  assert.equal(readiness.ledger.ok, true, label);
  assert.equal(readiness.ledger.count, 3, label);
  assert.equal(readiness.source.revision, REVISION, label);
  assert.equal(readiness.runtime.immune_server_sha256, DIGEST, label);
  assert.deepEqual(readiness.blockers, ["RECEIPT_LEDGER_DURABILITY_UNVERIFIED"], label);
}

test("rejected mount observations reach write-disabled readiness without erasing runtime evidence", () => {
  for (const filesystem of ["nfs4", "fuse.hf-mount", "unknownfs"]) {
    let fileObservations = 0;
    const forbidden = (): never => { fileObservations++; throw new Error("unqualified mount touched"); };
    const io = {
      readMountInfo: () => `1 0 8:1 / /data rw - ${filesystem} example rw`,
      lstat: forbidden, realpath: forbidden, access: forbidden,
      openExisting: forbidden, fstat: forbidden, fsync: forbidden, close: forbidden,
    };
    const authorityObservation = observeAuthorityStorage("/data/immune/authority.sqlite", { fileSystem: io });
    const authorityCandidate = writeReadyInputs();
    authorityCandidate.authority.authority.durability.verified = authorityObservation.available;
    const authorityResult = readinessHttpResult(dependencies(authorityCandidate));
    assert.equal(authorityResult.statusCode, 503);
    assert.equal(authorityResult.body.authority_ready, false);
    assert.equal(authorityResult.body.write_ready, false);
    assert.equal(authorityResult.body.runtime_ready, true);
    assert.equal(authorityResult.body.source.revision, REVISION);
    assert.ok(authorityResult.body.blockers.includes("ACTION_AUTHORITY_DURABILITY_UNVERIFIED"));

    const evidenceCandidate = writeReadyInputs();
    evidenceCandidate.ledgerDurability = ledgerDurability({ dataDir: "/data/immune/evidence", fileSystem: io });
    const evidenceResult = readinessHttpResult(dependencies(evidenceCandidate));
    assert.equal(evidenceResult.statusCode, 503);
    assertDurabilityBlocksOnlyWrites(evidenceResult.body, filesystem);
    assert.equal(fileObservations, 0, filesystem);
  }
});

test("omitted evidence durability input or callback cannot inherit authority storage readiness", () => {
  const candidate = writeReadyInputs();
  delete candidate.ledgerDurability;
  assertDurabilityBlocksOnlyWrites(buildReadinessContract(candidate), "missing input");

  const missingObserver = dependencies(writeReadyInputs());
  delete missingObserver.ledgerDurability;
  const observed = readinessStatus(missingObserver);
  assertDurabilityBlocksOnlyWrites(observed, "missing observer");
  assert.equal(observed.ledger.durability.verified, false);
  assert.equal(readinessHttpResult(missingObserver).statusCode, 503);
});

test("false and wrong-path evidence durability observations preserve read proof but deny writes", () => {
  for (const [name, observation] of [
    ["not verified", { ...observedLedgerDurability(), verified: false }],
    ["ephemeral path", { ...observedLedgerDurability(), path: "/app/data/immune" }],
    ["authority-only path", { ...observedLedgerDurability(), path: "/data/immune" }],
    ["trailing slash", { ...observedLedgerDurability(), path: "/data/immune/evidence/" }],
    ["noncanonical path", { ...observedLedgerDurability(), path: "/data/immune/../immune/evidence" }],
  ] as const) {
    const candidate = writeReadyInputs();
    candidate.ledgerDurability = observation;
    const result = buildReadinessContract(candidate);
    assertDurabilityBlocksOnlyWrites(result, name);
    assert.deepEqual(result.ledger.durability, observation, name);
    const http = readinessHttpResult(dependencies(candidate));
    assert.equal(http.statusCode, 503, name);
    assert.deepEqual(http.body, result, name);
  }
});

test("malformed evidence durability observations normalize unavailable without erasing independent proofs", () => {
  const valid = observedLedgerDurability();
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined], ["null", null], ["false", false],
    ["true", true], ["numeric", 1], ["string", "verified"],
    ["array", []], ["empty object", {}],
    ["required false", { ...valid, required: false }],
    ["required string", { ...valid, required: "true" }],
    ["verified string", { ...valid, verified: "true" }],
    ["verified number", { ...valid, verified: 1 }],
    ["path empty", { ...valid, path: "" }],
    ["path missing", { required: true, verified: true, mount_path: "/data", reason: "observed" }],
    ["path not a string", { ...valid, path: ["/data/immune/evidence"] }],
    ["mount missing", { required: true, verified: true, path: valid.path, reason: "observed" }],
    ["mount wrong", { ...valid, mount_path: "/app" }],
    ["mount trailing slash", { ...valid, mount_path: "/data/" }],
    ["mount not a string", { ...valid, mount_path: ["/data"] }],
    ["reason missing", { required: true, verified: true, path: valid.path, mount_path: "/data" }],
    ["reason empty", { ...valid, reason: "" }],
    ["reason not a string", { ...valid, reason: true }],
    ["unexpected field", { ...valid, restart_verified: true }],
  ];
  for (const [name, observation] of cases) {
    const candidate = writeReadyInputs();
    candidate.ledgerDurability = observation as ReadinessInputs["ledgerDurability"];
    const direct = buildReadinessContract(candidate);
    assertDurabilityBlocksOnlyWrites(direct, name);
    assert.equal(direct.ledger.durability.required, true, name);
    assert.equal(direct.ledger.durability.verified, false, name);
    assert.equal(direct.ledger.durability.path, "/data/immune/evidence", name);
    assert.equal(direct.ledger.durability.mount_path, "/data", name);
    assert.equal(typeof direct.ledger.durability.reason, "string", name);
    assert.ok(direct.ledger.durability.reason.length > 0, name);
    const http = readinessHttpResult(dependencies(candidate));
    assert.equal(http.statusCode, 503, name);
    assert.deepEqual(http.body, direct, name);
  }
});

test("throwing evidence durability observer cannot erase verified runtime or grant write readiness", () => {
  const candidate = dependencies(writeReadyInputs());
  let observations = 0;
  candidate.ledgerDurability = () => {
    observations += 1;
    throw new Error("volume observation unavailable");
  };
  const readiness = readinessStatus(candidate);
  assertDurabilityBlocksOnlyWrites(readiness, "throwing observer");
  assert.equal(readiness.ledger.durability.verified, false);
  const http = readinessHttpResult(candidate);
  assert.equal(http.statusCode, 503);
  assert.deepEqual(http.body, readiness);
  assert.equal(observations, 2);
});

test("configured authority without verified required durability is read-only and HTTP 503", () => {
  for (const durability of [
    { required: false, verified: true, path: "/data/immune" },
    { required: true, verified: false, path: "/data/immune" },
  ]) {
    const candidate = inputs();
    candidate.authority = {
      ...candidate.authority,
      mode: "PASS",
      evidenceState: "VERIFIED",
      reason: "signed action and receipt chain verified",
      validUntil: "2026-08-01T19:00:00.000Z",
      updatedAt: "2026-08-01T18:59:00.000Z",
      requestId: "durability-authority-0001",
      revision: 1,
      authorityReceiptCount: 1,
      authorityReceiptHash: DIGEST,
      authority: {
        ...authorityMetadata(true),
        durability,
      },
    };
    const readiness = buildReadinessContract(candidate);
    assert.equal(readiness.status, "READ_ONLY");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.runtime_ready, true);
    assert.equal(readiness.read_ready, true);
    assert.equal(readiness.authority_ready, false);
    assert.equal(readiness.write_ready, false);
    assert.ok(
      readiness.blockers.includes("ACTION_AUTHORITY_DURABILITY_UNVERIFIED"),
    );
    assert.deepEqual(readiness.authority.durability, durability);
    assert.equal(readinessHttpResult(dependencies(candidate)).statusCode, 503);
  }
});

test("agent status is LIVE only when inference and full server write readiness pass", () => {
  const blocked = inputs();
  blocked.authority = {
    ...blocked.authority,
    mode: "PASS",
    evidenceState: "VERIFIED",
    reason: "signed action and receipt chain verified",
    validUntil: "2026-08-01T19:00:00.000Z",
    updatedAt: "2026-08-01T18:59:00.000Z",
    requestId: "agent-status-authority-0001",
    revision: 1,
    authorityReceiptCount: 1,
    authorityReceiptHash: DIGEST,
    authority: authorityMetadata(true),
  };
  blocked.runtime.state = "MISMATCH";
  blocked.runtime.available = false;
  blocked.runtime.reason = "served artifact mismatch";
  blocked.source.alignment_state = "ARTIFACT_HASH_MISMATCH";
  blocked.source.alignment = "ARTIFACT_HASH_MISMATCH";
  blocked.source.state = "ARTIFACT_HASH_MISMATCH";
  blocked.source.claims.runtime_whitelist_hash_match = false;
  blocked.build.runtime_hash_match = false;
  blocked.build.build.runtime_hash_match = false;
  const blockedReadiness = buildReadinessContract(blocked);
  const dependencies: AgentStatusDependencies = {
    inferenceInfo: () => ({
      configured: true,
      provider: "test-provider",
      model: "test-model",
    }),
    readinessStatus: () => blockedReadiness,
    getState: () => blocked.authority,
    signingEnabled: () => true,
  };

  let status = agentStatus(dependencies);
  assert.equal(status.available, false);
  assert.equal(status.provenance, "UNAVAILABLE");
  assert.equal(status.readiness.status, "NOT_READY");
  assert.equal(status.readiness.write_ready, false);
  assert.ok(status.blockers.includes("RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED"));
  assert.match(status.note, /full server write-readiness contract/);

  const ready = inputs();
  ready.authority = blocked.authority;
  const readyReadiness = buildReadinessContract(ready);
  status = agentStatus({
    ...dependencies,
    readinessStatus: () => readyReadiness,
    getState: () => ready.authority,
  });
  assert.equal(status.available, true);
  assert.equal(status.provenance, "LIVE");
  assert.deepEqual(status.blockers, []);
});

test("verified reject and deadman authority never become write-ready", () => {
  for (const mode of ["SENTRA_REJECT", "DEADMAN"] as const) {
    const guarded = inputs();
    guarded.authority = {
      ...guarded.authority,
      mode,
      deadman: mode === "DEADMAN",
      tripwire: mode === "DEADMAN" ? "T01" : null,
      evidenceState: "VERIFIED",
      reason: "signed defensive action and receipt chain verified",
      validUntil: "2026-08-01T19:00:00.000Z",
      updatedAt: "2026-08-01T18:59:00.000Z",
      requestId: `verified-${mode.toLowerCase()}`,
      revision: 2,
      authorityReceiptCount: 2,
      authorityReceiptHash: DIGEST,
      authority: authorityMetadata(true),
    };
    const readiness = buildReadinessContract(guarded);
    assert.equal(readiness.status, "READ_ONLY", mode);
    assert.equal(readiness.runtime_ready, true, mode);
    assert.equal(readiness.authority_ready, false, mode);
    assert.equal(readiness.write_ready, false, mode);
    assert.equal(readiness.ready, false, mode);
    assert.deepEqual(readiness.blockers, [`ACTION_AUTHORITY_${mode}`], mode);
  }
});

test("runtime binding hashes the executed bundle and selected static tree", {
  concurrency: false,
}, (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-runtime-binding-"));
  const manifestRoot = path.join(temporary, "manifest");
  const runtimeRoot = path.join(temporary, "runtime");
  const runtimePublic = path.join(runtimeRoot, "public");
  const runtimeAssets = path.join(runtimePublic, "assets");
  fs.mkdirSync(path.join(manifestRoot, "public", "assets"), { recursive: true });
  fs.mkdirSync(runtimeAssets, { recursive: true });
  const serverBytes = "console.log('bound server');\n";
  const indexBytes = "<!doctype html><title>bound</title>\n";
  const scriptBytes = "console.log('bound client');\n";
  const styleBytes = ":root { color-scheme: dark; }\n";
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(manifestRoot, "immune-server.js"), serverBytes);
  fs.writeFileSync(path.join(manifestRoot, "public", "index.html"), indexBytes);
  fs.writeFileSync(
    path.join(manifestRoot, "public", "assets", "app.js"),
    scriptBytes,
  );
  fs.writeFileSync(
    path.join(manifestRoot, "public", "assets", "app.css"),
    styleBytes,
  );
  const runtimeServer = path.join(runtimeRoot, "immune-server.js");
  const runtimeIndex = path.join(runtimePublic, "index.html");
  const runtimeScript = path.join(runtimeAssets, "app.js");
  const runtimeStyle = path.join(runtimeAssets, "app.css");
  fs.writeFileSync(runtimeServer, serverBytes);
  fs.writeFileSync(runtimeIndex, indexBytes);
  fs.writeFileSync(runtimeScript, scriptBytes);
  fs.writeFileSync(runtimeStyle, styleBytes);
  const manifestPath = path.join(manifestRoot, "hf-deploy-manifest.json");
  const writeManifest = (artifacts: Record<string, string>) => {
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: "szl.hf-deploy-manifest/v2",
      source: {
        repository: "szl-holdings/immune",
        revision: REVISION,
        ref: "refs/heads/main",
      },
      workflow: { repository: null, run_id: null, run_attempt: null, ref: null },
      destination: { repo_id: "SZLHOLDINGS/immune", repo_type: "space", mode: "merge-main" },
      artifacts,
      claims: {
        github_actions_provenance_verified: false,
        cryptographic_release_receipt: false,
      },
    }));
  };
  const artifacts = {
    "immune-server.js": digest(serverBytes),
    "public/index.html": digest(indexBytes),
    "public/assets/app.js": digest(scriptBytes),
    "public/assets/app.css": digest(styleBytes),
  };
  writeManifest(artifacts);

  const names = [
    "IMMUNE_DEPLOY_MANIFEST_PATH",
    "IMMUNE_DEPLOY_MANIFEST",
    "IMMUNE_STATIC_DIR",
  ] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.IMMUNE_DEPLOY_MANIFEST_PATH = manifestPath;
    process.env.IMMUNE_DEPLOY_MANIFEST = manifestPath;
    process.env.IMMUNE_STATIC_DIR = runtimePublic;
    const selection = { serverPath: runtimeServer, staticDir: runtimePublic };
    let binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MATCH");
    assert.equal(binding.available, true);
    assert.equal(binding.reason, null);
    assert.equal(binding.immune_server_sha256, digest(serverBytes));
    assert.equal(binding.public_index_sha256, digest(indexBytes));

    fs.writeFileSync(runtimeServer, "console.log('unbound server');\n");
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MISMATCH");
    assert.equal(binding.available, false);
    assert.equal(
      binding.reason,
      "running server bundle digest does not match the deployment manifest",
    );
    assert.notEqual(binding.immune_server_sha256, digest(serverBytes));

    fs.rmSync(runtimeIndex);
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MISMATCH");
    assert.equal(
      binding.reason,
      "running server bundle digest does not match the deployment manifest",
    );

    fs.writeFileSync(runtimeServer, serverBytes);
    fs.writeFileSync(runtimeIndex, indexBytes);
    fs.writeFileSync(runtimeScript, "console.log('tampered client');\n");
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MISMATCH");
    assert.equal(
      binding.reason,
      "public/assets/app.js: selected runtime artifact digest mismatch",
    );

    fs.writeFileSync(runtimeScript, scriptBytes);
    fs.writeFileSync(runtimeIndex, "<!doctype html><title>unbound</title>\n");
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MISMATCH");
    assert.equal(binding.available, false);
    assert.equal(
      binding.reason,
      "public/index.html: selected runtime artifact digest mismatch",
    );
    assert.notEqual(binding.public_index_sha256, digest(indexBytes));

    fs.writeFileSync(runtimeIndex, indexBytes);
    fs.rmSync(runtimeStyle);
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "UNAVAILABLE");
    assert.equal(
      binding.reason,
      "public/assets/app.css: selected runtime artifact is unavailable",
    );
    fs.writeFileSync(runtimeStyle, styleBytes);

    binding = getRuntimeHashBinding({ serverPath: runtimeServer, staticDir: null });
    assert.equal(binding.state, "UNAVAILABLE");
    assert.equal(binding.reason, "selected runtime static directory is unavailable");

    fs.writeFileSync(runtimeServer, "console.log('unbound server');\n");
    const withoutRequiredIndex = { ...artifacts };
    delete (withoutRequiredIndex as Partial<typeof artifacts>)["public/index.html"];
    writeManifest(withoutRequiredIndex);
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "MISMATCH");
    assert.equal(
      binding.reason,
      "running server bundle digest does not match the deployment manifest",
    );

    fs.writeFileSync(runtimeServer, serverBytes);
    writeManifest({ "immune-server.js": digest(serverBytes) });
    binding = getRuntimeHashBinding({ serverPath: runtimeRoot, staticDir: runtimePublic });
    assert.equal(binding.state, "MISMATCH");
    assert.equal(
      binding.reason,
      "running server bundle is not a regular non-symlink file",
    );

    writeManifest(artifacts);
    const externalScript = path.join(temporary, "outside.js");
    fs.writeFileSync(externalScript, scriptBytes);
    fs.rmSync(runtimeScript);
    let symlinkCreated = false;
    try {
      fs.symlinkSync(externalScript, runtimeScript, "file");
      symlinkCreated = true;
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "UNKNOWN";
      assert.ok(["EPERM", "EACCES"].includes(code));
      t.diagnostic(`runtime symlink negative unavailable on this host: ${code}`);
      if (fs.existsSync(runtimeScript)) fs.rmSync(runtimeScript, { force: true });
    }
    if (symlinkCreated) {
      binding = getRuntimeHashBinding(selection);
      assert.equal(binding.state, "MISMATCH");
      assert.equal(
        binding.reason,
        "public/assets/app.js: selected runtime path contains a symlink",
      );
      fs.rmSync(runtimeScript);
    }
    fs.writeFileSync(runtimeScript, scriptBytes);

    writeManifest({
      "immune-server.js": digest(serverBytes),
      "public/index.html": digest(indexBytes),
      "public/../outside.js": digest(scriptBytes),
    });
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.state, "UNAVAILABLE");
    assert.equal(binding.reason, "deployment manifest artifact map is unsafe");

    writeManifest(artifacts);
    fs.writeFileSync(runtimeServer, serverBytes);
    fs.writeFileSync(runtimeIndex, indexBytes);
    fs.writeFileSync(runtimeScript, scriptBytes);
    fs.writeFileSync(runtimeStyle, styleBytes);
    const alternatePublic = path.join(temporary, "alternate-public");
    fs.mkdirSync(path.join(alternatePublic, "assets"), { recursive: true });
    fs.writeFileSync(path.join(alternatePublic, "index.html"), indexBytes);
    fs.writeFileSync(path.join(alternatePublic, "assets", "app.js"), scriptBytes);
    fs.writeFileSync(path.join(alternatePublic, "assets", "app.css"), styleBytes);

    assert.equal(bindRuntimeStaticDir(runtimePublic), path.resolve(runtimePublic));
    process.env.IMMUNE_STATIC_DIR = alternatePublic;
    fs.writeFileSync(runtimeScript, "console.log('startup tree tampered');\n");
    binding = getRuntimeHashBinding({ serverPath: runtimeServer });
    assert.equal(binding.state, "MISMATCH");
    assert.equal(
      binding.reason,
      "public/assets/app.js: selected runtime artifact digest mismatch",
    );
    assert.throws(
      () => bindRuntimeStaticDir(alternatePublic),
      /runtime static directory is already bound/,
    );
  } finally {
    for (const name of names) {
      const value = before[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("readyz is registered before static hosting and metadata is evidence-scoped", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "server/immune-standalone.ts"), "utf8");
  const readyRoute = server.indexOf('app.get("/readyz"');
  const healthRoute = server.indexOf('app.get("/healthz"');
  const staticHosting = server.indexOf("express.static(staticDir");
  const spaFallback = server.indexOf('app.get("/{*splat}"');
  const healthHandler = server.slice(healthRoute, readyRoute);
  assert.ok(healthRoute >= 0);
  assert.ok(readyRoute >= 0);
  assert.ok(staticHosting > readyRoute);
  assert.ok(spaFallback > readyRoute);
  assert.match(server, /const \{ statusCode, body \} = readinessHttpResult\(\)/);
  assert.match(
    server,
    /const staticDir = bindRuntimeStaticDir\(resolveRuntimeStaticDir\(__serverDir\)\)/,
  );
  assert.match(healthHandler, /readiness_state: "NOT_EVALUATED"/);
  assert.match(healthHandler, /readiness_endpoint: "\/readyz"/);
  assert.doesNotMatch(healthHandler, /readinessStatus|verifyLedger|getRuntimeHashBinding/);
  assert.doesNotMatch(healthHandler, /write_ready|verification_state|authority_state/);
  assert.match(server, /res\.status\(statusCode\)\.type\("application\/json"\)\.json\(body\)/);

  const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
  const home = fs.readFileSync(path.join(root, "frontend/src/pages/Home.tsx"), "utf8");
  const agentConsole = fs.readFileSync(
    path.join(root, "frontend/src/components/AgentConsole.tsx"),
    "utf8",
  );
  assert.match(html, /<title>IMMUNE \| Evidence-Scoped AI Defense<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/szlholdings-immune\.hf\.space\/"/);
  assert.match(html, /rel="source" href="https:\/\/github\.com\/szl-holdings\/immune"/);
  assert.match(html, /property="og:url" content="https:\/\/szlholdings-immune\.hf\.space\/"/);
  assert.match(html, /name="twitter:card" content="summary"/);
  assert.doesNotMatch(html, /Investor Demo|built on Replit|Update this description/);
  assert.match(home, /document\.title = "IMMUNE \| Evidence-Scoped AI Defense"/);
  assert.doesNotMatch(home, /document\.title = "IMMUNE — Verifiable-AI Defense"/);
  assert.match(home, /data-testid="controls-scroll-region"/);
  assert.match(home, /@5xl\/immune:overflow-y-auto/);
  assert.match(home, /@5xl\/immune:overscroll-contain/);
  assert.match(home, /tabIndex=\{0\}/);
  assert.match(home, /focus-visible:ring-2/);
  assert.match(agentConsole, /Governed agent blocked/);
  assert.match(agentConsole, /All write paths stay fail-closed/);
  assert.doesNotMatch(agentConsole, /manual governed cycle above still runs/iu);
});
