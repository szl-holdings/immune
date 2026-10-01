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
