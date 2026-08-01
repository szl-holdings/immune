import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const contractUrl = new URL("../server/contracts/decision-genome.ts", import.meta.url);
const provenanceUrl = new URL(
  "../server/contracts/decision-genome.snapshot.json",
  import.meta.url,
);

const [contractText, provenanceText] = await Promise.all([
  readFile(contractUrl, "utf8"),
  readFile(provenanceUrl, "utf8"),
]);

const provenance = JSON.parse(provenanceText);
// The snapshot digest is bound to the canonical Git blob, whose text uses LF.
// Windows checkouts may materialize the same tracked file with CRLF; normalize
// only that transport representation so an identical Git blob verifies on
// every supported development host without weakening the content check.
const canonicalContract = contractText.replace(/\r\n/gu, "\n");
const digest = createHash("sha256").update(canonicalContract, "utf8").digest("hex");
const sha256Pattern = /^[0-9a-f]{64}$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;

const failures = [];
if (provenance.schema !== "szl.contract-snapshot/v1") {
  failures.push("unexpected provenance schema");
}
if (provenance.contract_id !== "urn:szl:contracts:decision-genome:v1") {
  failures.push("unexpected contract id");
}
if (provenance.source_repository !== "szl-holdings/platform") {
  failures.push("unexpected source repository");
}
if (!revisionPattern.test(provenance.source_revision)) {
  failures.push("source revision must be a full Git commit SHA");
}
if (
  provenance.source_path !== "packages/contracts/src/decision-genome.ts"
) {
  failures.push("unexpected source path");
}
if (!/^[0-9a-f]{40}$/u.test(provenance.source_blob_sha)) {
  failures.push("source blob must be a full Git blob SHA");
}
if (!sha256Pattern.test(provenance.sha256)) {
  failures.push("snapshot SHA-256 is malformed");
}
if (digest !== provenance.sha256) {
  failures.push(
    `snapshot digest mismatch: expected ${provenance.sha256}, observed ${digest}`,
  );
}
if (provenance.license !== "Apache-2.0") {
  failures.push("unexpected source license");
}

if (failures.length > 0) {
  throw new Error(`Decision Genome snapshot check failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  JSON.stringify({
    contract_id: provenance.contract_id,
    source_revision: provenance.source_revision,
    source_blob_sha: provenance.source_blob_sha,
    sha256: digest,
    status: "MATCH",
  }),
);
