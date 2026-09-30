// This UI gate is advisory: the server repeats admission before any computation.
const REVISION = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const KEY_ID = /^[a-f0-9]{16}$/;

const exactString = (value, pattern) => typeof value === "string" && pattern.test(value);
const positiveCount = value => Number.isSafeInteger(value) && value > 0;

export function verifiedReadiness(value) {
  return value?.schema === "szl.immune-readiness/v1"
    && value.status === "READY"
    && [value.ready, value.read_ready, value.runtime_ready,
      value.authority_ready, value.write_ready].every(flag => flag === true)
    && Array.isArray(value.blockers) && value.blockers.length === 0
    && value.source?.repository === "szl-holdings/immune"
    && exactString(value.source.revision, REVISION)
    && exactString(value.source.build_revision, REVISION)
    && value.source.revision === value.source.build_revision
    && value.source.alignment_state === "OBSERVED_RUNTIME_HASH_MATCH"
    && value.source.manifest_schema === "szl.hf-deploy-manifest/v2"
    && value.build?.state === "OBSERVED_HASH_MATCH"
    && positiveCount(value.build.artifact_count)
    && value.build?.runtime_hash_match === true
    && value.build.artifact_set_algorithm === "sha256(json(sorted[path,sha256]))"
    && exactString(value.build.deployment_manifest_sha256, HASH)
    && exactString(value.build.artifact_set_sha256, HASH)
    && exactString(value.runtime?.immune_server_sha256, HASH)
    && exactString(value.runtime?.public_index_sha256, HASH)
    && value.runtime?.artifact_integrity?.status === "MATCH"
    && positiveCount(value.runtime.artifact_integrity.checked)
    && value.runtime.artifact_integrity.checked === value.build.artifact_count
    && Array.isArray(value.runtime.artifact_integrity.failures)
    && value.runtime.artifact_integrity.failures.length === 0
    && value.ledger?.ok === true && positiveCount(value.ledger.count)
    && value.ledger.first_bad_seq === null
    && value.ledger.durability?.required === true && value.ledger.durability.verified === true
    && value.ledger.durability.path === "/data/immune/evidence"
    && value.ledger.durability.mount_path === "/data"
    && typeof value.ledger.durability.reason === "string"
    && value.ledger.durability.reason.trim().length > 0
    && value.authority?.enabled === true
    && value.authority.version === "immune.action.v2"
    && value.authority.audience === "hf-space:SZLHOLDINGS/immune"
    && value.authority.external_operator === true
    && value.authority.evidence_state === "VERIFIED"
    && exactString(value.authority.source_revision, REVISION)
    && value.authority.source_revision === value.source.revision
    && exactString(value.authority.key_id, KEY_ID)
    && positiveCount(value.authority.receipt_count)
    && value.authority.deployment?.space === "SZLHOLDINGS/immune"
    && exactString(value.authority.deployment.revision, REVISION)
    && exactString(value.authority.receipt_hash, HASH)
    && value.authority.durability?.required === true
    && value.authority.durability.verified === true
    && value.authority.durability.path === "/data/immune";
}

export function matchingReadiness(ready, nexus) {
  const mirror = nexus?.immuneReadiness;
  return nexus?.state === "EXECUTABLE"
    && verifiedReadiness(ready) && verifiedReadiness(mirror)
    && ready.source.revision === mirror.source.revision
    && ready.build.artifact_count === mirror.build.artifact_count
    && ready.build.deployment_manifest_sha256 === mirror.build.deployment_manifest_sha256
    && ready.build.artifact_set_sha256 === mirror.build.artifact_set_sha256
    && ready.runtime.immune_server_sha256 === mirror.runtime.immune_server_sha256
    && ready.runtime.public_index_sha256 === mirror.runtime.public_index_sha256
    && ready.authority.key_id === mirror.authority.key_id
    && ready.authority.receipt_count === mirror.authority.receipt_count
    && ready.authority.deployment.revision === mirror.authority.deployment.revision
    && ready.authority.receipt_hash === mirror.authority.receipt_hash;
}

export function canExecute(status, now = Date.now(), visible = true, online = true) {
  return status?.writeReady === true && status.busy === false && visible === true && online === true
    && Number.isFinite(status.observedAt)
    && status.observedAt >= 0
    && Number.isFinite(now)
    && now >= status.observedAt && now - status.observedAt < 10_000;
}
