import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../frontend/deploy/dist/", import.meta.url));
const manifestPath = path.join(root, "hf-deploy-manifest.json");

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute)));
    } else if (entry.isFile() && absolute !== manifestPath) {
      files.push(absolute);
    }
  }
  return files;
}

let predecessor = {};
try {
  predecessor = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const artifacts = {};
for (const absolute of (await collectFiles(root)).sort()) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative === "data" || relative.startsWith("data/")) {
    continue;
  }
  artifacts[relative] = createHash("sha256")
    .update(await readFile(absolute))
    .digest("hex");
}

if (Object.keys(artifacts).length === 0) {
  throw new Error("Refusing to seal an empty deployment artifact set");
}

const sourceRepository =
  process.env.GITHUB_REPOSITORY ??
  predecessor.source_repository ??
  predecessor.repository ??
  null;
const sourceRevision =
  process.env.SOURCE_REVISION ??
  process.env.GITHUB_SHA ??
  predecessor.source_revision ??
  predecessor.revision ??
  null;

if (!sourceRepository || !sourceRevision) {
  throw new Error(
    "Deployment sealing requires a declared source repository and revision",
  );
}

const manifest = {
  schema: "szl.hf-deploy-manifest/v2",
  source: {
    repository: sourceRepository,
    revision: sourceRevision,
    ref: process.env.GITHUB_REF ?? predecessor.source_ref ?? null,
  },
  workflow: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    ref: process.env.GITHUB_REF ?? null,
  },
  destination:
    predecessor.destination ?? predecessor.destination_repository ?? null,
  artifacts,
  mutable_paths: ["data/"],
  claims: {
    github_actions_provenance_verified: false,
    cryptographic_release_receipt: false,
  },
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({
    schema: manifest.schema,
    source_revision: sourceRevision,
    artifact_count: Object.keys(artifacts).length,
    status: "SEALED",
  }),
);
