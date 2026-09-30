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
  ledgerDurability,
  type LedgerDurability,
  type VerifierReport,
} from "./routes/immune/ledger";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/u;

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
    durability: LedgerDurability;
  };
  authority: {
    enabled: boolean;
    evidence_state: EvidenceState;
    key_id: string | null;
    version: "immune.action.v2";
    audience: "hf-space:SZLHOLDINGS/immune";
    source_revision: string | null;
    deployment: {
      space: "SZLHOLDINGS/immune";
      revision: string | null;
    };
    external_operator: boolean;
    receipt_count: number;
    receipt_hash: string | null;
    durability: {
      required: boolean;
      verified: boolean;
      path: string | null;
    };
  };
};

export type ReadinessInputs = {
  source: SourceAttestation;
  build: BuildInfo;
  runtime: RuntimeHashBinding;
  ledger: VerifierReport;
  ledgerDurability?: LedgerDurability;
  authority: AuthoritySnapshot;
};

export type ReadinessDependencies = {
  sourceAttestation: () => SourceAttestation;
  buildInfo: () => BuildInfo;
  runtimeHashBinding: () => RuntimeHashBinding;
  verifyLedger: () => VerifierReport;
  ledgerDurability?: () => LedgerDurability;
  getState: () => AuthoritySnapshot;
};

export type ReadinessHttpResult = {
  statusCode: 200 | 503;
  body: ImmuneReadiness;
};

const LIVE_DEPENDENCIES: ReadinessDependencies = {
  sourceAttestation,
  buildInfo,
  runtimeHashBinding: getRuntimeHashBinding,
  verifyLedger,
  ledgerDurability,
  getState,
};

function addBlocker(blockers: string[], condition: boolean, blocker: string): void {
  if (condition) blockers.push(blocker);
}

function exactString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function positiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function authorityDurabilityReady(authority: AuthoritySnapshot): boolean {
  return authority.authority.durability.required === true &&
    authority.authority.durability.verified === true &&
    authority.authority.durability.path === "/data/immune";
}

export function isActionReady(
  authority: AuthoritySnapshot,
  sourceRevision: string | null,
  deploymentRevision: string | null,
): boolean {
  return (
    exactString(sourceRevision, REVISION_PATTERN) &&
    exactString(deploymentRevision, REVISION_PATTERN) &&
    authority.authority.enabled === true &&
    authority.authority.version === "immune.action.v2" &&
    authority.authority.audience === "hf-space:SZLHOLDINGS/immune" &&
    authority.authority.source.repository === "szl-holdings/immune" &&
    authority.authority.externalOperator === true &&
    authority.authority.source.revision === sourceRevision &&
    authority.authority.deployment.space === "SZLHOLDINGS/immune" &&
    authority.authority.deployment.revision === deploymentRevision &&
    authorityDurabilityReady(authority) &&
    exactString(authority.authority.keyId, KEY_ID_PATTERN) &&
    positiveCount(authority.authorityReceiptCount) &&
    exactString(authority.authorityReceiptHash, SHA256_PATTERN) &&
    authority.evidenceState === "VERIFIED" &&
    authority.mode === "PASS" &&
    authority.deadman === false &&
    authority.tripwire === null
  );
}

function unavailableReadiness(blockers: string[]): ImmuneReadiness {
  return {
    schema: "szl.immune-readiness/v1",
    status: "NOT_READY",
    ready: false,
    runtime_ready: false,
    read_ready: false,
    authority_ready: false,
    write_ready: false,
    blockers: [...new Set(blockers)],
    source: {
      repository: null,
      revision: null,
      build_revision: null,
      alignment_state: "REVISION_UNAVAILABLE",
      manifest_schema: null,
    },
    build: {
      state: "UNVERIFIED",
      artifact_count: 0,
      runtime_hash_match: false,
      artifact_set_algorithm: "sha256(json(sorted[path,sha256]))",
      deployment_manifest_sha256: null,
      artifact_set_sha256: null,
    },
    runtime: {
      immune_server_sha256: null,
      public_index_sha256: null,
      artifact_integrity: { status: "UNAVAILABLE", checked: 0, failures: [] },
    },
    ledger: {
      ok: false, count: 0, first_bad_seq: null,
      durability: unavailableLedgerDurability(),
    },
    authority: {
      enabled: false,
      evidence_state: "UNAVAILABLE",
      key_id: null,
      version: "immune.action.v2",
      audience: "hf-space:SZLHOLDINGS/immune",
      source_revision: null,
      deployment: { space: "SZLHOLDINGS/immune", revision: null },
      external_operator: true,
      receipt_count: 0,
      receipt_hash: null,
      durability: {
        required: true,
        verified: false,
        path: null,
      },
    },
  };
}

function unavailableLedgerDurability(): LedgerDurability {
  return {
    required: true,
    verified: false,
    path: "/data/immune/evidence",
    mount_path: "/data",
    reason: "receipt evidence durability has not been observed",
  };
}

function normalizeLedgerDurability(value: unknown): LedgerDurability {
  if (value === undefined || value === null) return unavailableLedgerDurability();
  const observed = value as Record<string, unknown>;
  if (
    typeof value !== "object" || Array.isArray(value) ||
    Object.keys(observed).sort().join(",") !== "mount_path,path,reason,required,verified" ||
    observed.required !== true || typeof observed.verified !== "boolean" ||
    typeof observed.path !== "string" || !observed.path.trim() ||
    observed.mount_path !== "/data" ||
    typeof observed.reason !== "string" || !observed.reason.trim()
  ) {
    return { ...unavailableLedgerDurability(), reason: "receipt evidence durability observation is malformed" };
  }
  return { ...observed } as unknown as LedgerDurability;
}

export function buildReadinessContract(inputs: ReadinessInputs): ImmuneReadiness {
  const { source, build, runtime, ledger, authority } = inputs;
  const blockers: string[] = [];
  const sourceRevision = source.source.commit;
  const deploymentRevision = source.expected_huggingface_revision;
  const sourceBound =
    source.source.repository === "szl-holdings/immune" &&
    exactString(sourceRevision, REVISION_PATTERN) &&
    sourceRevision === build.build.revision &&
    source.manifest_schema === "szl.hf-deploy-manifest/v2";
  const deploymentBound =
    source.alignment_state === "OBSERVED_RUNTIME_HASH_MATCH" &&
    source.claims.huggingface_revision_match === true &&
    exactString(deploymentRevision, REVISION_PATTERN) &&
    source.observed_huggingface_revision === deploymentRevision &&
    source.deployment.hf_space === "SZLHOLDINGS/immune" &&
    source.deployment.hf_revision === deploymentRevision;
  const runtimeBound =
    runtime.available === true &&
    runtime.state === "MATCH" &&
    runtime.source_repository === source.source.repository &&
    runtime.source_revision === sourceRevision &&
    exactString(runtime.deployment_manifest_sha256, SHA256_PATTERN) &&
    exactString(runtime.artifact_set_sha256, SHA256_PATTERN) &&
    exactString(runtime.immune_server_sha256, SHA256_PATTERN) &&
    exactString(runtime.public_index_sha256, SHA256_PATTERN) &&
    source.artifact_integrity.status === "MATCH" &&
    positiveCount(source.artifact_integrity.checked) &&
    Array.isArray(source.artifact_integrity.failures) &&
    source.artifact_integrity.failures.length === 0 &&
    source.claims.runtime_whitelist_hash_match === true &&
    build.state === "OBSERVED_HASH_MATCH" &&
    build.build.state === "OBSERVED_HASH_MATCH" &&
    positiveCount(build.artifact_count) &&
    source.artifact_integrity.checked === build.artifact_count &&
    build.build.artifact_count === build.artifact_count &&
    build.runtime_hash_match === true &&
    build.build.runtime_hash_match === true;

  addBlocker(blockers, !sourceBound, "SOURCE_BUILD_BINDING_UNVERIFIED");
  addBlocker(
    blockers,
    !deploymentBound,
    "DEPLOYMENT_REVISION_BINDING_UNVERIFIED",
  );
  addBlocker(blockers, !runtimeBound, "RUNTIME_ARTIFACT_INTEGRITY_UNVERIFIED");
  // Status labels cannot override contradictory observations. Keep these checks
  // at the server admission boundary, not only in the advisory Nexus UI.
  const ledgerIntegrityReady =
    ledger.ok === true &&
    Number.isSafeInteger(ledger.count) && ledger.count >= 0 &&
    ledger.firstBadSeq === null &&
    Array.isArray(ledger.issues) && ledger.issues.length === 0;
  const ledgerReady = ledgerIntegrityReady && positiveCount(ledger.count);
  addBlocker(blockers, !ledgerIntegrityReady, "RECEIPT_LEDGER_INTEGRITY_FAILED");
  addBlocker(blockers, ledgerIntegrityReady && ledger.count === 0, "RECEIPT_LEDGER_EMPTY");

  const runtimeReady = sourceBound && deploymentBound && runtimeBound && ledgerReady;
  const authorityStorageReady = authorityDurabilityReady(authority);
  const authorityReady = isActionReady(
    authority,
    sourceRevision,
    deploymentBound ? deploymentRevision : null,
  );
  if (authority.authority.enabled !== true) {
    blockers.push("ACTION_TRUST_ROOT_UNCONFIGURED");
  } else if (authority.evidenceState !== "VERIFIED") {
    blockers.push(`ACTION_AUTHORITY_${authority.evidenceState}`);
  } else if (authority.deadman || authority.mode === "DEADMAN") {
    blockers.push("ACTION_AUTHORITY_DEADMAN");
  } else if (authority.mode !== "PASS") {
    blockers.push(`ACTION_AUTHORITY_${authority.mode}`);
  } else if (authorityStorageReady && !authorityReady) {
    blockers.push("ACTION_AUTHORITY_BINDING_UNVERIFIED");
  }
  addBlocker(
    blockers,
    authority.authority.enabled === true && !authorityStorageReady,
    "ACTION_AUTHORITY_DURABILITY_UNVERIFIED",
  );
  const evidenceDurability = normalizeLedgerDurability(inputs.ledgerDurability);
  const evidenceDurabilityReady =
    evidenceDurability.required === true &&
    evidenceDurability.verified === true &&
    evidenceDurability.path === "/data/immune/evidence" &&
    evidenceDurability.mount_path === "/data";
  addBlocker(
    blockers,
    !evidenceDurabilityReady,
    "RECEIPT_LEDGER_DURABILITY_UNVERIFIED",
  );
  const writeReady = runtimeReady && authorityReady && evidenceDurabilityReady;

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
      durability: evidenceDurability,
    },
    authority: {
      enabled: authority.authority.enabled,
      evidence_state: authority.evidenceState,
      key_id: authority.authority.keyId,
      version: authority.authority.version,
      audience: authority.authority.audience,
      source_revision: authority.authority.source.revision,
      deployment: {
        space: authority.authority.deployment.space,
        revision: authority.authority.deployment.revision,
      },
      external_operator: authority.authority.externalOperator,
      receipt_count: authority.authorityReceiptCount,
      receipt_hash: authority.authorityReceiptHash,
      durability: {
        required: authority.authority.durability.required,
        verified: authority.authority.durability.verified,
        path: authority.authority.durability.path,
      },
    },
  };
}

export function readinessStatus(
  dependencies: ReadinessDependencies = LIVE_DEPENDENCIES,
): ImmuneReadiness {
  const dependencyBlockers: string[] = [];
  let source: SourceAttestation | undefined;
  let build: BuildInfo | undefined;
  let runtime: RuntimeHashBinding | undefined;
  let ledger: VerifierReport | undefined;
  let authority: AuthoritySnapshot | undefined;
  let evidenceDurability = unavailableLedgerDurability();

  try {
    source = dependencies.sourceAttestation();
  } catch {
    dependencyBlockers.push("SOURCE_ATTESTATION_UNAVAILABLE");
  }
  try {
    build = dependencies.buildInfo();
  } catch {
    dependencyBlockers.push("BUILD_INFO_UNAVAILABLE");
  }
  try {
    runtime = dependencies.runtimeHashBinding();
  } catch {
    dependencyBlockers.push("RUNTIME_HASH_BINDING_UNAVAILABLE");
  }
  try {
    ledger = dependencies.verifyLedger();
  } catch {
    dependencyBlockers.push("RECEIPT_LEDGER_UNAVAILABLE");
  }
  try {
    authority = dependencies.getState();
  } catch {
    dependencyBlockers.push("ACTION_AUTHORITY_UNAVAILABLE");
  }
  try {
    evidenceDurability = dependencies.ledgerDurability?.() ?? unavailableLedgerDurability();
  } catch {
    // Storage capability failure must not erase independent runtime/read proof.
    evidenceDurability = unavailableLedgerDurability();
  }

  if (!source || !build || !runtime || !ledger || !authority) {
    return unavailableReadiness(dependencyBlockers);
  }

  try {
    return buildReadinessContract({ source, build, runtime, ledger, authority, ledgerDurability: evidenceDurability });
  } catch {
    return unavailableReadiness(["READINESS_CONTRACT_EVALUATION_FAILED"]);
  }
}

export function readinessHttpResult(
  dependencies: ReadinessDependencies = LIVE_DEPENDENCIES,
): ReadinessHttpResult {
  const body = readinessStatus(dependencies);
  return { statusCode: body.ready ? 200 : 503, body };
}
