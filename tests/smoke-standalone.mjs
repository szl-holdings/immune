import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

  const state = await getJson("/api/immune/state");
  assert.equal(typeof state.ledgerCount, "number");
  assert.ok(state.ledgerCount > 0);

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
  assert.match(await page.text(), /<div id="root"><\/div>/);
  console.log("IMMUNE standalone smoke: 7/7 PASS");
} finally {
  child.kill();
  fs.rmSync(temporary, { recursive: true, force: true });
}
