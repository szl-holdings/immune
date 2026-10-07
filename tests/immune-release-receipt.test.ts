import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseReceipt, sha256 } from "../server/tools/immune-authority-contract";

function fixture(): any {
  const files = [{ path: "hf-deploy-manifest.json", sha256: "b".repeat(64) }];
  return {
    schema: "szl.immune-hf-release-receipt/v1", repository: "szl-holdings/immune",
    source_revision: "a".repeat(40),
    workflow: { repository: "szl-holdings/immune", path: ".github/workflows/deploy-hf-space.yml",
      run_id: "42", run_attempt: "1", ref: "refs/heads/main" },
    hf: { space: "SZLHOLDINGS/immune", parent_revision: "c".repeat(40), revision: "d".repeat(40) },
    manifest: { path: "hf-deploy-manifest.json", sha256: "b".repeat(64) },
    outputs: { files, set_sha256: sha256(Buffer.from(JSON.stringify(files))) },
    volume: { type: "bucket", source: "SZLHOLDINGS/immune-authority", mount_path: "/data", read_only: false },
    trust: { key_id: "e".repeat(16), trust_epoch: "f".repeat(32), public_key_sha256: "b".repeat(64) },
    authority: { instance_id: "1".repeat(32), revision: 0, receipt_hash: "GENESIS",
      evidence_state: "UNAVAILABLE", durability: { required: true, verified: true, path: "/data/immune" } },
    ledger: { ok: true, count: 12, first_bad_seq: null,
      durability: { required: true, verified: true, path: "/data/immune/evidence", mount_path: "/data" } },
    readiness: { status: "READ_ONLY", ready: false, runtime_ready: true,
      read_ready: true, authority_ready: false, write_ready: false },
  };
}

test("publication receipt requires independent exact durable evidence without claiming activation", () => {
  const valid = fixture();
  assert.deepEqual(parseReleaseReceipt(valid), valid);
  for (const patch of [
    { required: false }, { verified: false }, { verified: "true" },
    { path: "/app/data/immune" }, { mount_path: "/tmp" }, { extra: true },
  ]) {
    const receipt = fixture();
    Object.assign(receipt.ledger.durability, patch);
    assert.throws(() => parseReleaseReceipt(receipt), /evidence|unknown fields/);
  }
  for (const field of ["ledger", "readiness"]) {
    const receipt = fixture(); delete receipt[field];
    assert.throws(() => parseReleaseReceipt(receipt), /missing required fields/);
  }
  const activated = fixture(); activated.readiness.write_ready = true;
  assert.throws(() => parseReleaseReceipt(activated), /read-only readiness/);
});

// These are local parser fixtures, not production release or persistence evidence.
for (const [label, object, field] of [
  ["source revision", (value: any) => value, "source_revision"],
  ["HF parent revision", (value: any) => value.hf, "parent_revision"],
  ["HF revision", (value: any) => value.hf, "revision"],
  ["manifest digest", (value: any) => value.manifest, "sha256"],
  ["output digest", (value: any) => value.outputs.files[0], "sha256"],
  ["output set digest", (value: any) => value.outputs, "set_sha256"],
  ["authority receipt digest", (value: any) => value.authority, "receipt_hash"],
] as const) {
  test(`release receipt rejects non-string ${label} without coercion`, () => {
    for (const malformed of ["array", "null", "object", "number", "boolean"] as const) {
      const receipt = fixture();
      receipt.authority.revision = 1;
      receipt.authority.receipt_hash = "2".repeat(64);
      const target = object(receipt);
      const original = target[field];
      target[field] = malformed === "array" ? [original]
        : malformed === "null" ? null
          : malformed === "object" ? { value: original }
            : malformed === "number" ? 42 : true;
      // Keep the aggregate digest consistent so malformed file fields cannot
      // be rejected only as an unrelated aggregate-hash mismatch.
      if (label === "output digest") {
        receipt.outputs.set_sha256 = sha256(JSON.stringify(receipt.outputs.files));
      }
      assert.throws(() => parseReleaseReceipt(receipt), undefined, `${label}: ${malformed}`);
    }
  });
}

for (const authorityPath of [
  "/data/immune-other/authority.sqlite",
  "/data/immune/authority.sqlite",
  "/data/immune/../authority.sqlite",
  "/data/immune/./authority.sqlite",
  "/data/immune//authority.sqlite",
  "/data/immune/authority.sqlite/",
  "/data/immune\\authority.sqlite",
  "/data/immune/authority\u0000.sqlite",
  "/data/immune/authority\n.sqlite",
  "/data/immune/authority\u007f.sqlite",
  ["/data/immune/authority.sqlite"],
  null,
]) {
  test(`release receipt rejects noncanonical authority path ${JSON.stringify(authorityPath)}`, () => {
    const receipt = fixture();
    receipt.authority.durability.path = authorityPath;
    assert.throws(() => parseReleaseReceipt(receipt), /authority durability/);
  });
}

test("exact authority directory retains its bytes without claiming restart durability", () => {
  const receipt = fixture();
  assert.equal(parseReleaseReceipt(receipt).authority.durability.path, "/data/immune");
});
