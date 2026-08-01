import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildReadinessContract,
  readinessStatus,
  type ReadinessInputs,
} from "../server/readiness";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);

function inputs(): ReadinessInputs {
  return {
    source: {
      schema: "szl.source-attestation/v2",
      state: "REVISION_UNAVAILABLE",
      alignment: "REVISION_UNAVAILABLE",
      source_repository: "szl-holdings/immune",
      source_revision: REVISION,
      source_ref: "refs/heads/main",
      destination: "SZLHOLDINGS/immune",
      workflow: null,
      manifest_schema: "szl.hf-deploy-manifest/v2",
      artifact_integrity: { status: "MATCH", checked: 7, failures: [] },
      expected_huggingface_revision: null,
      observed_huggingface_revision: null,
      claims: {
        whole_repository_parity: false,
        runtime_whitelist_hash_match: true,
        huggingface_revision_match: false,
        github_actions_provenance_verified: false,
        cryptographic_release_receipt: false,
      },
      relation: "declared-github-source-with-runtime-hash-match",
      limits: [],
      alignment_state: "REVISION_UNAVAILABLE",
      source: {
        repository: "szl-holdings/immune",
        commit: REVISION,
        ref: "refs/heads/main",
      },
      deployment: { hf_space: "SZLHOLDINGS/immune", hf_revision: null },
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
      authority: { enabled: false, version: "immune.action.v1", keyId: null },
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

test("ledger read failures remain a fail-closed readiness contract", () => {
  const base = inputs();
  const readiness = readinessStatus({
    sourceAttestation: () => base.source,
    buildInfo: () => base.build,
    runtimeHashBinding: () => base.runtime,
    verifyLedger: () => {
      throw new Error("ledger unavailable");
    },
    getState: () => base.authority,
  });
  assert.equal(readiness.schema, "szl.immune-readiness/v1");
  assert.equal(readiness.status, "NOT_READY");
  assert.equal(readiness.runtime_ready, false);
  assert.equal(readiness.ledger.ok, false);
  assert.ok(readiness.blockers.includes("RECEIPT_LEDGER_INTEGRITY_FAILED"));
});

test("full READY requires both verified runtime and verified signed authority", () => {
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
    authority: {
      enabled: true,
      version: "immune.action.v1",
      keyId: "0123456789abcdef",
    },
  };
  const readiness = buildReadinessContract(ready);
  assert.equal(readiness.status, "READY");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.authority_ready, true);
  assert.equal(readiness.write_ready, true);
  assert.deepEqual(readiness.blockers, []);
});

test("readyz is registered before static hosting and metadata is evidence-scoped", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "server/immune-standalone.ts"), "utf8");
  const readyRoute = server.indexOf('app.get("/readyz"');
  const staticHosting = server.indexOf("express.static(staticDir");
  const spaFallback = server.indexOf('app.get("/{*splat}"');
  assert.ok(readyRoute >= 0);
  assert.ok(staticHosting > readyRoute);
  assert.ok(spaFallback > readyRoute);

  const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
  const home = fs.readFileSync(path.join(root, "frontend/src/pages/Home.tsx"), "utf8");
  assert.match(html, /<title>IMMUNE \| Evidence-Scoped AI Defense<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/szlholdings-immune\.hf\.space\/"/);
  assert.match(html, /rel="source" href="https:\/\/github\.com\/szl-holdings\/immune"/);
  assert.match(html, /property="og:url" content="https:\/\/szlholdings-immune\.hf\.space\/"/);
  assert.match(html, /name="twitter:card" content="summary"/);
  assert.doesNotMatch(html, /Investor Demo|built on Replit|Update this description/);
  assert.match(home, /document\.title = "IMMUNE \| Evidence-Scoped AI Defense"/);
  assert.doesNotMatch(home, /document\.title = "IMMUNE — Verifiable-AI Defense"/);
});
