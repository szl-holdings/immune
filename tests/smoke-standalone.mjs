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
const expectedHfRevision = process.env.IMMUNE_EXPECTED_HF_REVISION;
const observedHfRevision = process.env.HF_SPACE_REVISION;
assert.match(expectedHfRevision ?? "", /^[a-f0-9]{40}$/i);
assert.equal(observedHfRevision, expectedHfRevision);
assert.ok(fs.existsSync(path.join(dist, "immune-server.js")));
const productionBundle = fs.readFileSync(
  path.join(dist, "immune-server.js"),
  "utf8",
);
for (const forbidden of [
  "IMMUNE_ACTION_SIGNING_PKCS8_B64",
  "loadExternalOperatorIdentity",
  "createExternalActionEnvelope",
  "immune-authority-offline-signer",
]) {
  assert.equal(
    productionBundle.includes(forbidden),
    false,
    `production bundle contains action signer capability: ${forbidden}`,
  );
}
assert.ok(fs.existsSync(path.join(dist, "public", "index.html")));
assert.ok(fs.existsSync(path.join(dist, "hf-deploy-manifest.json")));
const actionTrustPath = path.join(dist, "immune-action-trust.json");
assert.ok(fs.existsSync(actionTrustPath));
const actionTrust = JSON.parse(fs.readFileSync(actionTrustPath, "utf8"));
assert.equal(actionTrust.schema, "szl.immune-action-trust/v1");
const trustConfigured = actionTrust.configured === true;

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
    IMMUNE_BIND_ADDRESS: "127.0.0.1",
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
  assert.equal(readinessResponse.status, 503);
  assert.match(readinessResponse.headers.get("content-type") ?? "", /^application\/json/);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.schema, "szl.immune-readiness/v1");
  assert.equal(readiness.status, "READ_ONLY");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.runtime_ready, true);
  assert.equal(readiness.read_ready, true);
  assert.equal(readiness.authority_ready, false);
  assert.equal(readiness.write_ready, false);
  if (trustConfigured) {
    assert.ok(readiness.blockers.includes("ACTION_AUTHORITY_UNAVAILABLE"));
    assert.ok(
      readiness.blockers.includes("ACTION_AUTHORITY_DURABILITY_UNVERIFIED"),
    );
  } else {
    assert.deepEqual(readiness.blockers.slice().sort(), ["ACTION_TRUST_ROOT_UNCONFIGURED", "RECEIPT_LEDGER_DURABILITY_UNVERIFIED"].sort());
  }
  assert.equal(readiness.source.repository, "szl-holdings/immune");
  assert.equal(readiness.source.revision, sourceRevision.toLowerCase());
  assert.equal(readiness.source.build_revision, sourceRevision.toLowerCase());
  assert.equal(readiness.source.alignment_state, "OBSERVED_RUNTIME_HASH_MATCH");
  assert.deepEqual(readiness.authority.deployment, {
    space: "SZLHOLDINGS/immune",
    revision: expectedHfRevision.toLowerCase(),
  });
  assert.equal(readiness.runtime.artifact_integrity.status, "MATCH");
  assert.equal(readiness.ledger.ok, true);
  assert.equal(readiness.ledger.durability.verified, false);
  assert.ok(readiness.blockers.includes("RECEIPT_LEDGER_DURABILITY_UNVERIFIED"));

  const nexusStatus = await getJson("/api/immune/nexus/status");
  assert.equal(nexusStatus.immuneReadiness.write_ready, false);
  assert.notEqual(nexusStatus.state, "EXECUTABLE");
  const nexusRun = await fetch(base + "/api/immune/nexus/run", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ program: "lorenz", mode: "OP", steps: 8,
      actor: "smoke-local-only", requestId: "smoke-nexus-v2-refused" }),
  });
  assert.equal(nexusRun.status, 503, await nexusRun.text());
  assert.equal((await getJson("/api/immune/state")).ledgerCount, readiness.ledger.count);
  const nexusPage = await fetch(base + "/nexus.html");
  assert.equal(nexusPage.status, 200);
  assert.match(await nexusPage.text(), /id="run"[^>]*disabled/);
  assert.equal((await fetch(base + "/nexus-readiness.js")).status, 200);

  const agentStatus = await getJson("/api/immune/agent/status");
  assert.equal(agentStatus.available, false);
  assert.equal(agentStatus.provenance, "UNAVAILABLE");
  assert.equal(agentStatus.readiness.status, "READ_ONLY");
  assert.equal(agentStatus.readiness.write_ready, false);
  assert.ok(agentStatus.blockers.includes("INFERENCE_UNCONFIGURED"));
  assert.ok(
    agentStatus.blockers.includes(
      trustConfigured
        ? "ACTION_AUTHORITY_DURABILITY_UNVERIFIED"
        : "ACTION_TRUST_ROOT_UNCONFIGURED",
    ),
  );

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
  assert.equal(state.authority.enabled, trustConfigured);
  assert.equal(state.authority.durability.required, true);
  assert.equal(state.authority.durability.verified, false);
  assert.deepEqual(state.authority.deployment, {
    space: "SZLHOLDINGS/immune",
    revision: expectedHfRevision.toLowerCase(),
  });
  if (trustConfigured) {
    assert.equal(state.authority.keyId, actionTrust.keyId);
    assert.equal(state.authority.trustEpoch, actionTrust.trustEpoch);
    assert.match(
      state.reason,
      /authority initialization unavailable: authority writes require a writable persistent \/data mount and \/data\/immune authority path/,
    );
  }
  assert.deepEqual(state.tripwireState, {
    evidenceState: "UNAVAILABLE",
    mode: "SENTRA_REJECT",
    deadman: false,
    tripwire: null,
    reason: state.reason,
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
  assert.equal(
    rejectedBody.error,
    trustConfigured
      ? "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE"
      : "AUTHORITY_UNAVAILABLE",
  );
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
    refusedCycleBody.blockers.includes(
      trustConfigured
        ? "ACTION_AUTHORITY_DURABILITY_UNVERIFIED"
        : "ACTION_TRUST_ROOT_UNCONFIGURED",
    ),
  );
  const stateAfterCycle = await getJson("/api/immune/state");
  assert.equal(stateAfterCycle.ledgerCount, ledgerBeforeCycle);

  const verification = await getJson("/api/immune/ledger/verify");
  assert.equal(verification.ok, true);

  const source = await getJson("/.well-known/szl-source.json");
  assert.equal(source.alignment_state, "OBSERVED_RUNTIME_HASH_MATCH");
  assert.equal(source.expected_huggingface_revision, expectedHfRevision.toLowerCase());
  assert.equal(source.observed_huggingface_revision, expectedHfRevision.toLowerCase());
  assert.equal(source.claims.huggingface_revision_match, true);
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
  assert.equal(build.expected_huggingface_revision, expectedHfRevision.toLowerCase());
  assert.equal(build.observed_huggingface_revision, expectedHfRevision.toLowerCase());
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
  console.log("IMMUNE standalone smoke: authority, source, ledger, NEXUS and artifact gates PASS");
} finally {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    await closed;
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
