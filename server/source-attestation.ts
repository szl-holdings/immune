import fs from "node:fs";
import path from "node:path";

const SOURCE_REPOSITORY = "szl-holdings/immune";
const SPACE_ID = "SZLHOLDINGS/immune";
const MANIFEST_PATH = path.resolve(
  process.env.IMMUNE_DEPLOY_MANIFEST ?? "hf-deploy-manifest.json",
);

interface DeployManifest {
  schema: "szl.hf-deploy-manifest/v1";
  source_repository: string;
  source_revision: string;
  source_path: string;
  workflow_run_id?: string;
}

function isFullSha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{40}$/i.test(value)
  );
}

function loadDeployManifest(): DeployManifest | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(MANIFEST_PATH, "utf8"),
    ) as Partial<DeployManifest>;
    if (
      parsed.schema !== "szl.hf-deploy-manifest/v1" ||
      parsed.source_repository !== SOURCE_REPOSITORY ||
      !isFullSha(parsed.source_revision) ||
      typeof parsed.source_path !== "string"
    ) {
      return null;
    }
    return parsed as DeployManifest;
  } catch {
    return null;
  }
}

let revisionCache:
  | { value: string | null; expiresAt: number }
  | undefined;

async function observedHfRevision(): Promise<string | null> {
  if (revisionCache && Date.now() < revisionCache.expiresAt) {
    return revisionCache.value;
  }
  let value: string | null = null;
  try {
    const response = await fetch(
      `https://huggingface.co/api/spaces/${SPACE_ID}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.ok) {
      const payload = (await response.json()) as { sha?: unknown };
      if (isFullSha(payload.sha)) value = payload.sha.toLowerCase();
    }
  } catch {
    value = null;
  }
  revisionCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

export async function sourceAttestation(): Promise<Record<string, unknown>> {
  const manifest = loadDeployManifest();
  const hfRevision = await observedHfRevision();
  const bound = manifest !== null;
  return {
    schema: "szl.deployment-source/v1",
    source: {
      repository: SOURCE_REPOSITORY,
      commit: manifest?.source_revision.toLowerCase() ?? null,
      path: manifest?.source_path ?? "",
      relation: bound
        ? "github-actions-source-bound-deployment"
        : "repository-reference-only",
    },
    deployment: {
      hf_space: SPACE_ID,
      hf_revision: hfRevision,
    },
    observed_at: new Date().toISOString(),
    alignment_state: bound
      ? "SOURCE_BOUND_DEPLOYMENT"
      : "SOURCE_REFERENCE_ONLY",
    claims: {
      whole_repository_byte_parity: false,
      runtime_whitelist_source_bound: bound,
    },
    limits: bound
      ? [
          "The workflow-generated manifest binds the deployed runtime whitelist to one exact GitHub commit.",
          "This does not claim whole-repository byte parity.",
        ]
      : [
          "No valid workflow-generated deployment manifest was observed.",
        ],
  };
}

export function buildInfo(): Record<string, unknown> {
  const manifest = loadDeployManifest();
  return {
    build: {
      state: manifest ? "OBSERVED" : "UNVERIFIED",
      revision: manifest?.source_revision.toLowerCase() ?? null,
      source_repository: SOURCE_REPOSITORY,
      receipt_minted: false,
    },
  };
}
