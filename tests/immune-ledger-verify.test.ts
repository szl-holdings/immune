// Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
// Runs the real verifyLedger against tampered ledgers. Each case is a separate
// process because ledger.ts fixes DATA_DIR and signing.ts caches the key at import.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_MOD = pathToFileURL(path.join(ROOT, "server/routes/immune/ledger.ts")).href;
const CANON_MOD = pathToFileURL(path.join(ROOT, "server/routes/immune/canonical.ts")).href;
const SEED_LEDGER = path.join(ROOT, "data/immune/ledger.jsonl");

const DRIVER = `
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const { appendReceipt, verifyLedger } = await import(${JSON.stringify(LEDGER_MOD)});
const { canonicalBytes } = await import(${JSON.stringify(CANON_MOD)});
const n = Number(process.env.APPEND_N ?? "0");
for (let i = 0; i < n; i++) {
  await appendReceipt({ payload: { actor: "test", intent: "case " + i } });
}
const file = path.join(process.env.IMMUNE_DATA_DIR, "ledger.jsonl");
const rows = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
const strip = (r) => { delete r.sig; delete r.alg; delete r.pub; delete r.kid; };
switch (process.env.MUTATE ?? "") {
  case "flip_payload": rows[0].payload.intent += "x"; break;
  case "bad_prev": rows[1].prevHash = "0".repeat(64); break;
  case "corrupt_sig": {
    const raw = Buffer.from(rows[0].sig, "base64");
    raw[0] ^= 0xff;
    rows[0].sig = raw.toString("base64");
    break;
  }
  case "foreign_resign": {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    for (const r of rows) {
      const bytes = canonicalBytes({ seq: r.seq, ts: r.ts, prevHash: r.prevHash, payload: r.payload });
      r.alg = "ed25519";
      r.sig = crypto.sign(null, bytes, privateKey).toString("base64");
      r.pub = pubRaw.toString("base64");
      r.kid = crypto.createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);
    }
    break;
  }
  case "strip_last": strip(rows[rows.length - 1]); break;
  case "strip_all": rows.forEach(strip); break;
}
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
process.stdout.write(JSON.stringify({ report: verifyLedger(), signed: rows.map((r) => Boolean(r.sig)) }));
`;

interface Report {
  ok: boolean;
  count: number;
  issues: Array<{ seq: number; kind: string; detail: string }>;
  firstBadSeq: number | null;
}

function run(t: test.TestContext, opts: {
  signingKey?: string;
  fromSeq?: string;
  appendN?: number;
  mutate?: string;
  seed?: boolean;
}): { report: Report; signed: boolean[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "immune-ledger-verify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (opts.seed) fs.copyFileSync(SEED_LEDGER, path.join(dir, "ledger.jsonl"));
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", IMMUNE_DATA_DIR: dir };
  delete env.IMMUNE_SIGNING_KEY;
  delete env.IMMUNE_SIGNING_FROM_SEQ;
  if (opts.signingKey !== undefined) env.IMMUNE_SIGNING_KEY = opts.signingKey;
  if (opts.fromSeq !== undefined) env.IMMUNE_SIGNING_FROM_SEQ = opts.fromSeq;
  env.APPEND_N = String(opts.appendN ?? 0);
  env.MUTATE = opts.mutate ?? "";
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", DRIVER], {
    cwd: ROOT, env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const KEY = () => crypto.randomBytes(32).toString("base64");
const kinds = (r: Report) => r.issues.map((i) => `${i.seq}:${i.kind}`);

test("flipped payload byte is bad_hash", (t) => {
  const { report } = run(t, { appendN: 2, mutate: "flip_payload" });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["1:bad_hash"]);
});

test("broken prevHash is bad_prev", (t) => {
  const { report } = run(t, { appendN: 2, mutate: "bad_prev" });
  assert.equal(report.ok, false);
  assert.ok(kinds(report).includes("2:bad_prev"), JSON.stringify(report));
});

test("corrupted signature with signing on is bad_sig", (t) => {
  const { report, signed } = run(t, { signingKey: KEY(), appendN: 2, mutate: "corrupt_sig" });
  assert.deepEqual(signed, [true, true]);
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["1:bad_sig"]);
});

test("foreign-key signature with signing on is untrusted_key", (t) => {
  const { report } = run(t, { signingKey: KEY(), appendN: 2, mutate: "foreign_resign" });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["1:untrusted_key", "2:untrusted_key"]);
});

test("foreign-key signature with signing off is untrusted_key, not trusted", (t) => {
  const { report } = run(t, { signingKey: "", appendN: 2, mutate: "foreign_resign" });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["1:untrusted_key", "2:untrusted_key"]);
});

test("stripping a signature after a signed receipt is missing_sig", (t) => {
  const { report, signed } = run(t, { signingKey: KEY(), appendN: 3, mutate: "strip_last" });
  assert.deepEqual(signed, [true, true, false]);
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["3:missing_sig"]);
});

test("stripping every signature past the declared epoch is missing_sig", (t) => {
  const { report, signed } = run(t, { signingKey: KEY(), fromSeq: "1", appendN: 2, mutate: "strip_all" });
  assert.deepEqual(signed, [false, false]);
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report), ["1:missing_sig", "2:missing_sig"]);
});

test("seeded unsigned ledger verifies with signing off", (t) => {
  const { report } = run(t, { seed: true });
  assert.deepEqual(report, { ok: true, count: 6, issues: [], firstBadSeq: null });
});

test("seeded unsigned history plus a signed append verifies when the epoch starts after it", (t) => {
  const { report, signed } = run(t, { seed: true, signingKey: KEY(), fromSeq: "7", appendN: 1 });
  assert.deepEqual(signed, [false, false, false, false, false, false, true]);
  assert.deepEqual(report, { ok: true, count: 7, issues: [], firstBadSeq: null });
});

test("invalid IMMUNE_SIGNING_FROM_SEQ with signing on fails closed", (t) => {
  const { report } = run(t, { signingKey: KEY(), fromSeq: "abc", appendN: 1 });
  assert.equal(report.ok, false);
  assert.ok(
    report.issues.some((i) => i.kind === "missing_sig" && i.detail.includes("invalid IMMUNE_SIGNING_FROM_SEQ")),
    JSON.stringify(report),
  );
});
