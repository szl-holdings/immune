import {
  buildInfo,
  getRuntimeHashBinding,
  sourceAttestation,
  type BuildInfo,
  type RuntimeHashBinding,
  type SourceAttestation,
} from "./source-attestation";
import {
  getState,
  type AuthoritySnapshot,
  type EvidenceState,
} from "./routes/immune/state";
import {
  verifyLedger,
  type VerifierReport,
} from "./routes/immune/ledger";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export type ReadinessStatus = "READY" | "READ_ONLY" | "NOT_READY";

export type ImmuneReadiness = {
  schema: "szl.immune-readiness/v1";
  status: ReadinessStatus;
  ready: boolean;
  runtime_ready: boolean;
  read_ready: boolean;
  authority_ready: boolean;
  write_ready: boolean;
  blockers: string[];
  source: {
    repository: string | null;
    revision: string | null;
    build_revision: string | null;
    alignment_state: SourceAttestation["alignment_state"];
    manifest_schema: string | null;
  };
  build: {
    state: BuildInfo["state"];
    artifact_count: number;
    runtime_hash_match: boolean;
    artifact_set_algorithm: "sha256(json(sorted[path,sha256]))";
    deployment_manifest_sha256: string | null;
    artifact_set_sha256: string | null;
  };
  runtime: {
    immune_server_sha256: string | null;
    public_index_sha256: string | null;
    artifact_integrity: SourceAttestation["artifact_integrity"];
  };
  ledger: {
    ok: boolean;
    count: number;
    first_bad_seq: number | null;
  };
  authority: {
    enabled: boolean;
    evidence_state: EvidenceState;
    key_id: string | null;
    receipt_count: number;
    receipt_hash: string | null;
  };
};

export type ReadinessInputs = {
  source: SourceAttestation;
  build: BuildInfo;
  runtime: RuntimeHashBinding;
  ledger: VerifierReport;
  authority: AuthoritySnapshot;
};

export type ReadinessDependencies = {
  sourceAttestation: () => SourceAttestation;
  buildInfo: () => BuildInfo;
  runtimeHashBinding: () => RuntimeHashBinding;
  verifyLedger: () => VerifierReport;
  getState: () => AuthoritySnapshot;
};

const LIVE_DEPENDENCIES: ReadinessDependencies = {
  sourceAttestation,
  buildInfo,
  runtimeHashBinding: getRuntimeHashBinding,
  verifyLedger,
  getState,
};

function addBlocker(blockers: string[], condition: boolean, blocker: string): void {
  if (condition) blockers.push(blocker);
}

export function buildReadinessContract(inputs: ReadinessInputs): ImmuneReadiness {
  const { source, build, runtime, ledger, authority } = inputs;
  const blockers: string[] = [];
  const sourceRevision = source.source.commit;
  const sourceBound =
    source.source.repository === "szl-holdings/immune" &&
    REVISION_PATTERN.test(sourceRevision ?? "") &&
    sourceRevision === build.build.revision &&
    source.manifest_schema === "szl.hf-deploy-manifest/v2" &&
    !["INVALID_MANIFEST", "ARTIFACT_HASH_MISMATCH", "REVISION_DRIFT"].includes(
      source.alignment_state,
    );
  const runtimeBound =
    runtime.available &&
    runtime.source_repository === source.source.repository &&
    runtime.source_revision === sourceRevision &&
    SHA256_PATTERN.test(runtime.deployment_manifest_sha256 ?? "") &&
    SHA256_PATTERN.test(runtime.artifact_set_sha256 ?? "") &&
    SHA256_PATTERN.test(runtime.immune_server_sha256 ?? "") &&
    SHA256_PATTERN.test(runtime.public_index_sha256 ?? "") &&
    source.artifact_integrity.status === "MATCH" &&
    source.claims.runtime_whitelist_hash_match &&
    build.runtime_hash_match;

  addBlocker(blockers, !sourceBound, "SOURCE_BUILD_BINDING_UNVERIFIED");
  addBlocker(blockers, !runtimeBound, "RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED");
  const ledgerReady = ledger.ok && ledger.count > 0;
  addBlocker(blockers, !ledger.ok, "RECEIPT_LEDGER_INTEGRITY_FAILED");
  addBlocker(blockers, ledger.ok && ledger.count === 0, "RECEIPT_LEDGER_EMPTY");

  const runtimeReady = sourceBound && runtimeBound && ledgerReady;
  const authorityReady =
    authority.authority.enabled && authority.evidenceState === "VERIFIED";
  if (!authority.authority.enabled) {
    blockers.push("ACTION_TRUST_ROOT_UNCONFIGURED");
  } else if (!authorityReady) {
    blockers.push(`ACTION_AUTHORITY_${authority.evidenceState}`);
  }
  const writeReady = runtimeReady && authorityReady;

  return {
    schema: "szl.immune-readiness/v1",
    status: writeReady ? "READY" : runtimeReady ? "READ_ONLY" : "NOT_READY",
    ready: writeReady,
    runtime_ready: runtimeReady,
    read_ready: runtimeReady,
    authority_ready: authorityReady,
    write_ready: writeReady,
    blockers,
    source: {
      repository: source.source.repository,
      revision: sourceRevision,
      build_revision: build.build.revision,
      alignment_state: source.alignment_state,
      manifest_schema: source.manifest_schema,
    },
    build: {
      state: build.state,
      artifact_count: build.artifact_count,
      runtime_hash_match: build.runtime_hash_match,
      artifact_set_algorithm: "sha256(json(sorted[path,sha256]))",
      deployment_manifest_sha256: runtime.deployment_manifest_sha256,
      artifact_set_sha256: runtime.artifact_set_sha256,
    },
    runtime: {
      immune_server_sha256: runtime.immune_server_sha256,
      public_index_sha256: runtime.public_index_sha256,
      artifact_integrity: source.artifact_integrity,
    },
    ledger: {
      ok: ledger.ok,
      count: ledger.count,
      first_bad_seq: ledger.firstBadSeq,
    },
    authority: {
      enabled: authority.authority.enabled,
      evidence_state: authority.evidenceState,
      key_id: authority.authority.keyId,
      receipt_count: authority.authorityReceiptCount,
      receipt_hash: authority.authorityReceiptHash,
    },
  };
}

export function readinessStatus(
  dependencies: ReadinessDependencies = LIVE_DEPENDENCIES,
): ImmuneReadiness {
  let ledger: VerifierReport;
  try {
    ledger = dependencies.verifyLedger();
  } catch {
    ledger = { ok: false, count: 0, issues: [], firstBadSeq: null };
  }
  return buildReadinessContract({
    source: dependencies.sourceAttestation(),
    build: dependencies.buildInfo(),
    runtime: dependencies.runtimeHashBinding(),
    ledger,
    authority: dependencies.getState(),
  });
}
