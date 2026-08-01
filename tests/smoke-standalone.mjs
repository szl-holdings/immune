import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dist = path.join(repoRoot, "frontend", "deploy", "dist");
const sourceRevision = process.env.SOURCE_REVISION;
assert.match(sourceRevision ?? "", /^[a-f0-9]{40}$/i);
assert.ok(fs.existsSync(path.join(dist, "immune-server.js")));
assert.ok(fs.existsSync(path.join(dist, "public", "index.html")));
assert.ok(fs.existsSync(path.join(dist, "hf-deploy-manifest.json")));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-smoke-"));
const dataDir = path.join(temporary, "data", "immune");
fs.mkdirSync(dataDir, { recursive: true });
for (const name of ["ledger.jsonl", "huklla_evidence.jsonl"]) {
  fs.copyFileSync(
    path.join(dist, "data", "immune", name),
    path.join(dataDir, name),
  );
}

const port = 18_000 + Math.floor(Math.random() * 1_000);
const child = spawn(process.execPath, ["immune-server.js"], {
  cwd: dist,
  env: {
    ...process.env,
    PORT: String(port),
    IMMUNE_DATA_DIR: dataDir,
    IMMUNE_DEPLOY_MANIFEST: path.join(dist, "hf-deploy-manifest.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += String(chunk);
});
child.stderr.on("data", (chunk) => {
  output += String(chunk);
});

const base = `http://127.0.0.1:${port}`;
async function getJson(route) {
  const response = await fetch(base + route);
  if (response.status !== 200) {
    assert.fail(`${route}: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

try {
  let ready = false;
  let lastReadyError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(base + "/healthz");
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const health = JSON.parse(body);
      assert.equal(health.transport_state, "REACHABLE");
      assert.equal(health.readiness_state, "NOT_EVALUATED");
      assert.equal(health.readiness_endpoint, "/readyz");
      assert.equal(Object.hasOwn(health, "write_ready"), false);
      ready = true;
      break;
    } catch (error) {
      lastReadyError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(
    ready,
    true,
    `server did not start: ${lastReadyError}\n${output}`,
  );

  const readinessResponse = await fetch(base + "/readyz");
  assert.equal(readinessResponse.status, 200);
  assert.match(readinessResponse.headers.get("content-type") ?? "", /^application\/json/);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.schema, "szl.immune-readiness/v1");
  assert.equal(readiness.status, "READ_ONLY");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.runtime_ready, true);
  assert.equal(readiness.read_ready, true);
  assert.equal(readiness.authority_ready, false);
  assert.equal(readiness.write_ready, false);
  assert.deepEqual(readiness.blockers, ["ACTION_TRUST_ROOT_UNCONFIGURED"]);
  assert.equal(readiness.source.repository, "szl-holdings/immune");
  assert.equal(readiness.source.revision, sourceRevision.toLowerCase());
  assert.equal(readiness.source.build_revision, sourceRevision.toLowerCase());
  assert.equal(readiness.runtime.artifact_integrity.status, "MATCH");
  assert.equal(readiness.ledger.ok, true);

  const agentStatus = await getJson("/api/immune/agent/status");
  assert.equal(agentStatus.available, false);
  assert.equal(agentStatus.provenance, "UNAVAILABLE");
  assert.equal(agentStatus.readiness.status, "READ_ONLY");
  assert.equal(agentStatus.readiness.write_ready, false);
  assert.ok(agentStatus.blockers.includes("INFERENCE_UNCONFIGURED"));
  assert.ok(agentStatus.blockers.includes("ACTION_TRUST_ROOT_UNCONFIGURED"));

  const manifestPath = path.join(dist, "hf-deploy-manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const artifactEntries = Object.entries(manifest.artifacts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(readiness.build.deployment_manifest_sha256, sha256(manifestBytes));
  assert.equal(readiness.build.artifact_set_sha256, sha256(JSON.stringify(artifactEntries)));
  assert.equal(readiness.runtime.immune_server_sha256, manifest.artifacts["immune-server.js"]);
  assert.equal(readiness.runtime.public_index_sha256, manifest.artifacts["public/index.html"]);

  const state = await getJson("/api/immune/state");
  assert.equal(typeof state.ledgerCount, "number");
  assert.ok(state.ledgerCount > 0);
  assert.equal(state.evidenceState, "UNAVAILABLE");
  assert.equal(state.mode, "SENTRA_REJECT");
  assert.equal(state.deadman, false);
  assert.equal(state.tripwire, null);
  assert.equal(state.validUntil, null);
  assert.equal(state.authority.enabled, false);
  assert.deepEqual(state.tripwireState, {
    evidenceState: "UNAVAILABLE",
    mode: "SENTRA_REJECT",
    deadman: false,
    tripwire: null,
    reason: "signed action trust root is not configured",
    updatedAt: null,
    requestId: null,
    revision: 0,
    validUntil: null,
  });
  assert.deepEqual(
    {
      evidenceState: state.evidenceState,
      mode: state.mode,
      deadman: state.deadman,
      tripwire: state.tripwire,
      reason: state.reason,
      updatedAt: state.updatedAt,
      requestId: state.requestId,
      revision: state.revision,
      validUntil: state.validUntil,
    },
    state.tripwireState,
  );
  assert.equal(state.durableState.mode, "SENTRA_REJECT");
  assert.equal(state.durableState.deadman, false);

  const rejectedAction = await fetch(base + "/api/immune/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(rejectedAction.status, 503);
  const rejectedBody = await rejectedAction.json();
  assert.equal(rejectedBody.error, "AUTHORITY_UNAVAILABLE");
  assert.deepEqual(
    {
      evidenceState: rejectedBody.state.evidenceState,
      mode: rejectedBody.state.mode,
      deadman: rejectedBody.state.deadman,
      tripwire: rejectedBody.state.tripwire,
      reason: rejectedBody.state.reason,
      updatedAt: rejectedBody.state.updatedAt,
      requestId: rejectedBody.state.requestId,
      revision: rejectedBody.state.revision,
      validUntil: rejectedBody.state.validUntil,
    },
    rejectedBody.state.tripwireState,
  );
  assert.equal(rejectedBody.state.evidenceState, "UNAVAILABLE");
  assert.equal(rejectedBody.state.mode, "SENTRA_REJECT");

  const ledgerBeforeCycle = state.ledgerCount;
  const invalidCycle = await fetch(base + "/api/immune/cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(invalidCycle.status, 400);
  assert.equal((await invalidCycle.json()).error, "invalid body");

  const refusedCycle = await fetch(base + "/api/immune/cycle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actor: "operator:standalone-smoke",
      intent: "prove the full write-readiness boundary",
    }),
  });
  assert.equal(refusedCycle.status, 503);
  const refusedCycleBody = await refusedCycle.json();
  assert.equal(refusedCycleBody.error, "WRITE_NOT_READY");
  assert.ok(
    refusedCycleBody.blockers.includes("ACTION_TRUST_ROOT_UNCONFIGURED"),
  );
  const stateAfterCycle = await getJson("/api/immune/state");
  assert.equal(stateAfterCycle.ledgerCount, ledgerBeforeCycle);

  const verification = await getJson("/api/immune/ledger/verify");
  assert.equal(verification.ok, true);

  const source = await getJson("/.well-known/szl-source.json");
  assert.equal(source.alignment_state, "REVISION_UNAVAILABLE");
  assert.equal(source.source.repository, "szl-holdings/immune");
  assert.equal(source.source.commit, sourceRevision.toLowerCase());
  assert.equal(source.artifact_integrity.status, "MATCH");
  assert.equal(source.claims.runtime_whitelist_hash_match, true);
  assert.equal(source.claims.github_actions_provenance_verified, false);
  assert.equal(source.claims.cryptographic_release_receipt, false);

  const build = await getJson("/api/build-info");
  assert.equal(build.build.state, "OBSERVED_HASH_MATCH");
  assert.equal(build.build.revision, sourceRevision.toLowerCase());
  assert.equal(build.build.runtime_hash_match, true);
  assert.equal(build.build.receipt_minted, false);

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /IMMUNE \| Evidence-Scoped AI Defense/);
  assert.match(html, /rel="canonical" href="https:\/\/szlholdings-immune\.hf\.space\/"/);
  assert.doesNotMatch(html, /Investor Demo|built on Replit/);

  // A corrupted evidence ledger must take readiness down without lying about
  // process liveness. This exercises the real built server and filesystem.
  fs.appendFileSync(path.join(dataDir, "ledger.jsonl"), "not-json\n", "utf8");
  const refusedReadiness = await fetch(base + "/readyz");
  assert.equal(refusedReadiness.status, 503);
  const refusedReadinessBody = await refusedReadiness.json();
  assert.equal(refusedReadinessBody.status, "NOT_READY");
  assert.equal(refusedReadinessBody.ready, false);
  assert.equal(refusedReadinessBody.runtime_ready, false);
  assert.equal(refusedReadinessBody.read_ready, false);
  assert.equal(refusedReadinessBody.ledger.ok, false);
  assert.notEqual(refusedReadinessBody.ledger.first_bad_seq, null);
  assert.ok(refusedReadinessBody.blockers.includes("RECEIPT_LEDGER_INTEGRITY_FAILED"));

  const stillLive = await fetch(base + "/healthz");
  assert.equal(stillLive.status, 200);
  const stillLiveBody = await stillLive.json();
  assert.equal(stillLiveBody.transport_state, "REACHABLE");
  assert.equal(stillLiveBody.readiness_state, "NOT_EVALUATED");
  assert.equal(stillLiveBody.readiness_endpoint, "/readyz");
  assert.equal(Object.hasOwn(stillLiveBody, "write_ready"), false);
  console.log("IMMUNE standalone smoke: 13/13 PASS");
} finally {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    await closed;
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
