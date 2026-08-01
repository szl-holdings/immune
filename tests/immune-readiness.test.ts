import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getRuntimeHashBinding } from "../server/source-attestation";
import {
  buildReadinessContract,
  readinessHttpResult,
  readinessStatus,
  type ReadinessDependencies,
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

function dependencies(): ReadinessDependencies {
  const base = inputs();
  return {
    sourceAttestation: () => base.source,
    buildInfo: () => base.build,
    runtimeHashBinding: () => base.runtime,
    verifyLedger: () => base.ledger,
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
      authority: {
        enabled: true,
        version: "immune.action.v1",
        keyId: "0123456789abcdef",
      },
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
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-runtime-binding-"));
  const manifestRoot = path.join(temporary, "manifest");
  const runtimeRoot = path.join(temporary, "runtime");
  const runtimePublic = path.join(runtimeRoot, "public");
  fs.mkdirSync(path.join(manifestRoot, "public"), { recursive: true });
  fs.mkdirSync(runtimePublic, { recursive: true });
  const serverBytes = "console.log('bound server');\n";
  const indexBytes = "<!doctype html><title>bound</title>\n";
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(manifestRoot, "immune-server.js"), serverBytes);
  fs.writeFileSync(path.join(manifestRoot, "public", "index.html"), indexBytes);
  const runtimeServer = path.join(runtimeRoot, "immune-server.js");
  const runtimeIndex = path.join(runtimePublic, "index.html");
  fs.writeFileSync(runtimeServer, serverBytes);
  fs.writeFileSync(runtimeIndex, indexBytes);
  const manifestPath = path.join(manifestRoot, "hf-deploy-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "szl.hf-deploy-manifest/v2",
      source: {
        repository: "szl-holdings/immune",
        revision: REVISION,
        ref: "refs/heads/main",
      },
      workflow: { repository: null, run_id: null, run_attempt: null, ref: null },
      destination: "SZLHOLDINGS/immune",
      artifacts: {
        "immune-server.js": digest(serverBytes),
        "public/index.html": digest(indexBytes),
      },
      claims: {
        github_actions_provenance_verified: false,
        cryptographic_release_receipt: false,
      },
    }),
  );

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
    assert.equal(binding.available, true);
    assert.equal(binding.reason, null);
    assert.equal(binding.immune_server_sha256, digest(serverBytes));
    assert.equal(binding.public_index_sha256, digest(indexBytes));

    fs.writeFileSync(runtimeServer, "console.log('unbound server');\n");
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.available, false);
    assert.equal(
      binding.reason,
      "running server bundle digest does not match the deployment manifest",
    );
    assert.notEqual(binding.immune_server_sha256, digest(serverBytes));

    fs.writeFileSync(runtimeServer, serverBytes);
    fs.writeFileSync(runtimeIndex, "<!doctype html><title>unbound</title>\n");
    binding = getRuntimeHashBinding(selection);
    assert.equal(binding.available, false);
    assert.equal(
      binding.reason,
      "selected runtime index digest does not match the deployment manifest",
    );
    assert.notEqual(binding.public_index_sha256, digest(indexBytes));
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
  const staticHosting = server.indexOf("express.static(staticDir");
  const spaFallback = server.indexOf('app.get("/{*splat}"');
  assert.ok(readyRoute >= 0);
  assert.ok(staticHosting > readyRoute);
  assert.ok(spaFallback > readyRoute);
  assert.match(server, /const \{ statusCode, body \} = readinessHttpResult\(\)/);
  assert.match(server, /const readiness = readinessStatus\(\)/);
  assert.match(server, /write_ready: readiness\.write_ready/);
  assert.match(server, /verification_state: readiness\.authority\.evidence_state/);
  assert.doesNotMatch(server, /write_ready: isActionReady\(authority\)/);
  assert.match(server, /res\.status\(statusCode\)\.type\("application\/json"\)\.json\(body\)/);

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
