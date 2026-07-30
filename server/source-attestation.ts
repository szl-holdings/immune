import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const MANIFEST_SCHEMA = "szl.hf-deploy-manifest/v2";

type DeployManifest = {
  schema: string;
  source: {
    repository: string;
    revision: string;
    ref: string | null;
  };
  workflow: {
    repository: string | null;
    run_id: string | null;
    run_attempt: string | null;
    ref: string | null;
  };
  destination: string | null;
  artifacts: Record<string, string>;
  mutable_paths?: string[];
  claims: {
    github_actions_provenance_verified: false;
    cryptographic_release_receipt: false;
  };
};

export type SourceAlignment =
  | "INVALID_MANIFEST"
  | "ARTIFACT_HASH_MISMATCH"
  | "REVISION_UNAVAILABLE"
  | "REVISION_DRIFT"
  | "OBSERVED_RUNTIME_HASH_MATCH";

export type SourceAttestation = {
  schema: "szl.source-attestation/v2";
  state: SourceAlignment;
  alignment: SourceAlignment;
  source_repository: string | null;
  source_revision: string | null;
  source_ref: string | null;
  destination: string | null;
  workflow: DeployManifest["workflow"] | null;
  manifest_schema: string | null;
  artifact_integrity: {
    status: "MATCH" | "MISMATCH" | "UNAVAILABLE";
    checked: number;
    failures: string[];
  };
  expected_huggingface_revision: string | null;
  observed_huggingface_revision: string | null;
  claims: {
    whole_repository_parity: false;
    runtime_whitelist_hash_match: boolean;
    huggingface_revision_match: boolean;
    github_actions_provenance_verified: false;
    cryptographic_release_receipt: false;
  };
  relation: string;
  limits: string[];
  alignment_state: SourceAlignment;
  source: {
    repository: string | null;
    commit: string | null;
    ref: string | null;
  };
  deployment: {
    hf_space: string | null;
    hf_revision: string | null;
  };
};

export type BuildInfo = {
  schema: "szl.build-info/v2";
  state: "OBSERVED_HASH_MATCH" | "UNVERIFIED";
  source_repository: string | null;
  source_revision: string | null;
  expected_huggingface_revision: string | null;
  observed_huggingface_revision: string | null;
  artifact_count: number;
  runtime_hash_match: boolean;
  receipt_minted: false;
  build: {
    state: "OBSERVED_HASH_MATCH" | "UNVERIFIED";
    revision: string | null;
    artifact_count: number;
    runtime_hash_match: boolean;
    receipt_minted: false;
  };
};

type ManifestResult =
  | {
      ok: true;
      path: string;
      root: string;
      manifest: DeployManifest;
    }
  | {
      ok: false;
      reason: string;
    };

function candidateManifestPaths(): string[] {
  return [
    process.env.IMMUNE_DEPLOY_MANIFEST_PATH,
    process.env.IMMUNE_DEPLOY_MANIFEST,
    path.resolve(process.cwd(), "hf-deploy-manifest.json"),
    path.resolve(
      process.cwd(),
      "frontend",
      "deploy",
      "dist",
      "hf-deploy-manifest.json",
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(): ManifestResult {
  const manifestPath = candidateManifestPaths().find((candidate) =>
    existsSync(candidate),
  );
  if (!manifestPath) {
    return { ok: false, reason: "deployment manifest not found" };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, reason: "deployment manifest is not valid JSON" };
  }

  if (
    !isRecord(value) ||
    value.schema !== MANIFEST_SCHEMA ||
    !isRecord(value.source) ||
    typeof value.source.repository !== "string" ||
    !REVISION_PATTERN.test(String(value.source.revision)) ||
    !isRecord(value.workflow) ||
    !isRecord(value.artifacts) ||
    Object.keys(value.artifacts).length === 0 ||
    !isRecord(value.claims) ||
    value.claims.github_actions_provenance_verified !== false ||
    value.claims.cryptographic_release_receipt !== false
  ) {
    return { ok: false, reason: "deployment manifest schema validation failed" };
  }

  for (const [relative, digest] of Object.entries(value.artifacts)) {
    if (
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").includes("..") ||
      typeof digest !== "string" ||
      !SHA256_PATTERN.test(digest)
    ) {
      return { ok: false, reason: "deployment manifest artifact map is unsafe" };
    }
  }

  return {
    ok: true,
    path: manifestPath,
    root: path.dirname(manifestPath),
    manifest: value as unknown as DeployManifest,
  };
}

function verifyArtifacts(result: ManifestResult): {
  status: "MATCH" | "MISMATCH" | "UNAVAILABLE";
  checked: number;
  failures: string[];
} {
  if (!result.ok) {
    return { status: "UNAVAILABLE", checked: 0, failures: [result.reason] };
  }

  const failures: string[] = [];
  let checked = 0;
  for (const [relative, expected] of Object.entries(result.manifest.artifacts)) {
    const absolute = path.resolve(result.root, ...relative.split("/"));
    if (
      absolute !== result.root &&
      !absolute.startsWith(`${result.root}${path.sep}`)
    ) {
      failures.push(`${relative}: path escaped deployment root`);
      continue;
    }
    try {
      const observed = createHash("sha256")
        .update(readFileSync(absolute))
        .digest("hex");
      checked += 1;
      if (observed !== expected) {
        failures.push(`${relative}: digest mismatch`);
      }
    } catch {
      failures.push(`${relative}: artifact unavailable`);
    }
  }

  return {
    status: failures.length === 0 ? "MATCH" : "MISMATCH",
    checked,
    failures,
  };
}

function normalizeRevision(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return REVISION_PATTERN.test(normalized) ? normalized : null;
}

export function getSourceAttestation(): SourceAttestation {
  const result = readManifest();
  const integrity = verifyArtifacts(result);
  const manifest = result.ok ? result.manifest : null;
  const expectedRevision = normalizeRevision(
    process.env.IMMUNE_EXPECTED_HF_REVISION,
  );
  const observedRevision = normalizeRevision(
    process.env.HF_SPACE_REVISION ?? process.env.SPACE_REVISION,
  );
  const revisionMatch =
    expectedRevision !== null &&
    observedRevision !== null &&
    expectedRevision === observedRevision;

  let alignment: SourceAlignment;
  if (!result.ok) {
    alignment = "INVALID_MANIFEST";
  } else if (integrity.status !== "MATCH") {
    alignment = "ARTIFACT_HASH_MISMATCH";
  } else if (expectedRevision === null || observedRevision === null) {
    alignment = "REVISION_UNAVAILABLE";
  } else if (!revisionMatch) {
    alignment = "REVISION_DRIFT";
  } else {
    alignment = "OBSERVED_RUNTIME_HASH_MATCH";
  }

  return {
    schema: "szl.source-attestation/v2",
    state: alignment,
    alignment,
    source_repository: manifest?.source.repository ?? null,
    source_revision: manifest?.source.revision ?? null,
    source_ref: manifest?.source.ref ?? null,
    destination: manifest?.destination ?? null,
    workflow: manifest?.workflow ?? null,
    manifest_schema: manifest?.schema ?? null,
    artifact_integrity: integrity,
    expected_huggingface_revision: expectedRevision,
    observed_huggingface_revision: observedRevision,
    claims: {
      whole_repository_parity: false,
      runtime_whitelist_hash_match: integrity.status === "MATCH",
      huggingface_revision_match: revisionMatch,
      github_actions_provenance_verified: false,
      cryptographic_release_receipt: false,
    },
    relation:
      integrity.status === "MATCH"
        ? "declared-github-source-with-runtime-hash-match"
        : "declared-source-without-runtime-hash-match",
    limits: [
      "The local manifest declares source identity but does not independently authenticate its issuer.",
      "Runtime hashes cover only the manifest whitelist, not whole-repository parity.",
      "Hugging Face revision equality requires a platform-observed revision environment value.",
      "No cryptographic release receipt or GitHub Actions provenance is minted by this runtime.",
    ],
    alignment_state: alignment,
    source: {
      repository: manifest?.source.repository ?? null,
      commit: manifest?.source.revision ?? null,
      ref: manifest?.source.ref ?? null,
    },
    deployment: {
      hf_space:
        process.env.SPACE_ID ?? process.env.HF_SPACE ?? manifest?.destination ?? null,
      hf_revision: expectedRevision ?? observedRevision,
    },
  };
}

export function getBuildInfo(): BuildInfo {
  const attestation = getSourceAttestation();
  const state = attestation.claims.runtime_whitelist_hash_match
    ? "OBSERVED_HASH_MATCH"
    : "UNVERIFIED";
  return {
    schema: "szl.build-info/v2",
    state,
    source_repository: attestation.source_repository,
    source_revision: attestation.source_revision,
    expected_huggingface_revision: attestation.expected_huggingface_revision,
    observed_huggingface_revision: attestation.observed_huggingface_revision,
    artifact_count: attestation.artifact_integrity.checked,
    runtime_hash_match: attestation.claims.runtime_whitelist_hash_match,
    receipt_minted: false,
    build: {
      state,
      revision: attestation.source_revision,
      artifact_count: attestation.artifact_integrity.checked,
      runtime_hash_match: attestation.claims.runtime_whitelist_hash_match,
      receipt_minted: false,
    },
  };
}

export const readSourceAttestation = getSourceAttestation;
export const buildSourceAttestation = getSourceAttestation;
export const loadSourceAttestation = getSourceAttestation;
export const readBuildInfo = getBuildInfo;
export const sourceAttestation = getSourceAttestation;
export const buildInfo = getBuildInfo;
