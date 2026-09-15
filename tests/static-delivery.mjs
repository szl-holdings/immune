// SPDX-License-Identifier: Apache-2.0
// Exercise the real built frontend/server pair. No external provider, model,
// credential, browser-rendering, or production-authorization claim is made.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "frontend/deploy/dist");
const reportDirectory = path.join(root, "reports/static-delivery");
fs.mkdirSync(reportDirectory, { recursive: true });
const reportPath = path.join(reportDirectory, "observation.json");
assert.equal(fs.existsSync(reportPath), false, "never reuse an old observation");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const observation = {
  schema: "szl.immune-static-delivery/v1",
  observedAt: new Date().toISOString(),
  sourceRepository: "szl-holdings/immune",
  sourceRevision: process.env.SOURCE_REVISION ?? null,
  checkoutRevision: null,
  node: process.version,
  state: "INCOMPLETE",
  assets: [],
  negativeControls: [],
  browserRendered: false,
  liveDeploymentVerified: false,
  productionInferenceAuthorized: false,
  credentialValuesRecorded: false,
};
let temporary;
let child;
let childClosed;
let childError;
let output = "";
let outputExceeded = false;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function attribute(attributes, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return pattern.exec(attributes)?.[2];
}

async function unusedLocalPort() {
  const reservation = net.createServer();
  try {
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  } finally {
    if (reservation.listening) {
      await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    }
  }
}

try {
  assert.match(observation.sourceRevision ?? "", /^[a-f0-9]{40}$/);
  observation.checkoutRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  }).trim();
  assert.match(observation.checkoutRevision, /^[a-f0-9]{40}$/);
  observation.executingTestSha256 = hash(fs.readFileSync(new URL(import.meta.url)));
  const manifestPath = path.join(dist, "hf-deploy-manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, "szl.hf-deploy-manifest/v2");
  assert.equal(manifest.source.repository, observation.sourceRepository);
  assert.equal(manifest.source.revision, observation.sourceRevision);
  observation.deploymentManifestSha256 = hash(manifestBytes);
  for (const name of ["immune-server.js", "public/index.html"]) {
    assert.equal(hash(fs.readFileSync(path.join(dist, name))), manifest.artifacts[name]);
  }

  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "immune-static-delivery-"));
  const data = path.join(temporary, "data/immune");
  fs.mkdirSync(data, { recursive: true });
  for (const name of ["ledger.jsonl", "huklla_evidence.jsonl"]) {
    fs.copyFileSync(path.join(dist, "data/immune", name), path.join(data, name));
  }
  const port = await unusedLocalPort();
  const base = `http://127.0.0.1:${port}`;
  // Pass only the local read-only runtime fixture inputs. No provider or action
  // credentials, NODE_OPTIONS, proxy, or deployment tokens are inherited.
  child = spawn(process.execPath, ["immune-server.js"], {
    cwd: dist,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: temporary,
      TMPDIR: temporary,
      NODE_ENV: "production",
      SOURCE_REVISION: observation.sourceRevision,
      PORT: String(port),
      IMMUNE_DATA_DIR: data,
      IMMUNE_DEPLOY_MANIFEST: manifestPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childClosed = new Promise((resolve) => child.once("close", resolve));
  child.on("error", (error) => { childError = error; });
  const capture = (bytes) => {
    if (outputExceeded) return;
    output += String(bytes);
    if (Buffer.byteLength(output) > 1024 * 1024) {
      outputExceeded = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const request = (route, options = {}) => {
    const url = new URL(route, base);
    assert.equal(url.origin, base, "fixture requests are same-origin only");
    return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(5_000) });
  };
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null && !childError && !outputExceeded) {
    try {
      const response = await request("/api/build-info");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.build.revision, observation.sourceRevision);
      assert.equal(body.build.runtime_hash_match, true);
      ready = true;
      break;
    } catch {
      await pause(100);
    }
  }
  assert.equal(ready, true, `owned server did not start: ${childError ?? output.slice(-4000)}`);
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  const entries = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attribute(match[1], "src");
    if (!src) continue;
    const url = new URL(src, base);
    if (url.origin !== base) continue;
    assert.equal(attribute(match[1], "type"), "module", "first-party entry must belong to the module build graph");
    entries.push({ kind: "script", url });
  }
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (attribute(match[1], "rel") !== "stylesheet") continue;
    const href = attribute(match[1], "href");
    assert.ok(href);
    const url = new URL(href, base);
    if (url.origin === base) entries.push({ kind: "style", url });
  }
  assert.ok(entries.some((entry) => entry.kind === "script"));
  assert.ok(entries.some((entry) => entry.kind === "style"));
  assert.ok(entries.length <= 32, "unexpected entry-asset inventory");
  let emittedJavaScript = "";
  for (const { kind, url } of entries) {
    assert.equal(url.search + url.hash, "");
    const relative = "public/" + decodeURIComponent(url.pathname).replace(/^\//, "");
    assert.ok(Object.hasOwn(manifest.artifacts, relative), `unsealed entry asset: ${relative}`);
    const served = await request(url.pathname);
    assert.equal(served.status, 200, `missing ${relative}`);
    const mime = served.headers.get("content-type") ?? "";
    assert.match(mime, kind === "script" ? /^(?:text|application)\/javascript\b/i : /^text\/css\b/i);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024);
    assert.doesNotMatch(bytes.toString("utf8", 0, 256), /^\s*(?:<!doctype\s+html|<html)/i);
    assert.equal(hash(bytes), manifest.artifacts[relative], `served artifact differs: ${relative}`);
    observation.assets.push({ path: relative, contentType: mime, bytes: bytes.length, sha256: hash(bytes) });
    if (kind === "script") emittedJavaScript += bytes.toString("utf8");
  }
  assert.ok(emittedJavaScript.includes("__SZL_HOLO_V2__"), "holographic implementation was omitted from emitted JavaScript");
  assert.ok(emittedJavaScript.includes("SZLPublicExperience"), "public-experience implementation was omitted");

  const missing = [
    ["/assets/__missing__.js", {}], ["/assets/__missing__.css", {}],
    ["/assets/__missing__", {}], ["/__missing__.mjs?version=1", {}],
    ["/__missing__%2ejs", {}], ["/__missing__.woff2", {}],
    ["/__missing_asset__", { "Sec-Fetch-Dest": "script" }],
    ["/__missing_asset__", { "Sec-Fetch-Dest": "style" }],
    ["/__missing_asset__", { "Sec-Fetch-Dest": "font" }],
  ];
  for (const [route, headers] of missing) {
    const rejected = await request(route, { headers });
    assert.equal(rejected.status, 404, `asset fallback returned a false success: ${route}`);
    assert.match(rejected.headers.get("content-type") ?? "", /^application\/json\b/i);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    assert.deepEqual(await rejected.json(), { error: "asset not found" });
    observation.negativeControls.push({ route, destination: headers["Sec-Fetch-Dest"] ?? null, status: 404 });
  }
  const head = await request("/assets/__missing__.js", { method: "HEAD" });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), "");
  const navigation = await request("/__document_navigation__", { headers: { "Sec-Fetch-Dest": "document" } });
  assert.equal(navigation.status, 200);
  assert.match(navigation.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(await navigation.text(), /<div id="root"><\/div>/);
  const api = await request("/api/__missing__.js");
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: "not found" });
  assert.equal(hash(fs.readFileSync(manifestPath)), observation.deploymentManifestSha256);
  for (const name of ["immune-server.js", "public/index.html"]) {
    assert.equal(hash(fs.readFileSync(path.join(dist, name))), manifest.artifacts[name]);
  }
  assert.equal(outputExceeded, false);
  observation.state = "BUILT_HTTP_ASSET_DELIVERY_VERIFIED";
  observation.documentFallbackPreserved = true;
  observation.unknownApiRemainsJson404 = true;
  observation.missingAssetHeadStatus = 404;
} catch (error) {
  observation.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([childClosed, pause(2_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([childClosed, pause(2_000)]);
  }
  if (child && child.exitCode === null && child.signalCode === null && !childError) {
    observation.state = "INCOMPLETE";
    observation.error = "owned child termination not confirmed";
    process.exitCode = 1;
  }
  if (temporary && (!child || child.exitCode !== null || child.signalCode !== null || childError)) {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  observation.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(observation, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(observation, null, 2));
}
