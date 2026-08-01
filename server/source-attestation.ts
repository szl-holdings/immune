import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export type RuntimeHashBinding = {
  available: boolean;
  reason: string | null;
  source_repository: string | null;
  source_revision: string | null;
  deployment_manifest_sha256: string | null;
  artifact_set_sha256: string | null;
  immune_server_sha256: string | null;
  public_index_sha256: string | null;
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

function runtimeServerPath(): string {
  return fileURLToPath(import.meta.url);
}

export function resolveRuntimeStaticDir(
  serverDir = path.dirname(runtimeServerPath()),
): string | null {
  const candidates = [
    process.env.IMMUNE_STATIC_DIR,
    path.resolve(serverDir, "public"),
    path.resolve(serverDir, "dist", "public"),
    path.resolve(process.cwd(), "public"),
    path.resolve(process.cwd(), "dist", "public"),
    path.resolve(serverDir, "..", "..", "immune-demo", "dist", "public"),
  ].filter((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0
  );

  for (const directory of candidates) {
    if (existsSync(path.join(directory, "index.html"))) return directory;
  }
  return null;
}

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

export function getRuntimeHashBinding(
  selection: { serverPath?: string; staticDir?: string | null } = {},
): RuntimeHashBinding {
  const result = readManifest();
  if (!result.ok) {
    return {
      available: false,
      reason: result.reason,
      source_repository: null,
      source_revision: null,
      deployment_manifest_sha256: null,
      artifact_set_sha256: null,
      immune_server_sha256: null,
      public_index_sha256: null,
    };
  }

  const entries = Object.entries(result.manifest.artifacts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const digest = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const immuneServerSha256 = result.manifest.artifacts["immune-server.js"] ?? null;
  const publicIndexSha256 = result.manifest.artifacts["public/index.html"] ?? null;
  const requiredHashesPresent =
    SHA256_PATTERN.test(immuneServerSha256 ?? "") &&
    SHA256_PATTERN.test(publicIndexSha256 ?? "");
  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(result.path);
  } catch {
    return {
      available: false,
      reason: "deployment manifest became unavailable during verification",
      source_repository: result.manifest.source.repository,
      source_revision: result.manifest.source.revision,
      deployment_manifest_sha256: null,
      artifact_set_sha256: null,
      immune_server_sha256: null,
      public_index_sha256: null,
    };
  }

  const serverPath = selection.serverPath ?? runtimeServerPath();
  const staticDir =
    selection.staticDir === undefined
      ? resolveRuntimeStaticDir(path.dirname(serverPath))
      : selection.staticDir;
  let observedServerSha256: string | null = null;
  let observedIndexSha256: string | null = null;
  let runtimeReason: string | null = null;
  try {
    observedServerSha256 = digest(readFileSync(serverPath));
  } catch {
    runtimeReason = "running server bundle is unavailable";
  }
  if (staticDir === null) {
    runtimeReason ??= "selected runtime static directory is unavailable";
  } else {
    try {
      observedIndexSha256 = digest(readFileSync(path.join(staticDir, "index.html")));
    } catch {
      runtimeReason ??= "selected runtime index is unavailable";
    }
  }
  if (runtimeReason === null && observedServerSha256 !== immuneServerSha256) {
    runtimeReason = "running server bundle digest does not match the deployment manifest";
  }
  if (runtimeReason === null && observedIndexSha256 !== publicIndexSha256) {
    runtimeReason = "selected runtime index digest does not match the deployment manifest";
  }
  if (!requiredHashesPresent) {
    runtimeReason = "deployment manifest is missing required runtime artifact hashes";
  }

  return {
    available: requiredHashesPresent && runtimeReason === null,
    reason: runtimeReason,
    source_repository: result.manifest.source.repository,
    source_revision: result.manifest.source.revision,
    deployment_manifest_sha256: digest(manifestBytes),
    artifact_set_sha256: digest(JSON.stringify(entries)),
    immune_server_sha256: observedServerSha256,
    public_index_sha256: observedIndexSha256,
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
  const runtime = getRuntimeHashBinding();
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
  } else if (integrity.status !== "MATCH" || !runtime.available) {
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
      runtime_whitelist_hash_match:
        integrity.status === "MATCH" && runtime.available,
      huggingface_revision_match: revisionMatch,
      github_actions_provenance_verified: false,
      cryptographic_release_receipt: false,
    },
    relation:
      integrity.status === "MATCH" && runtime.available
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
