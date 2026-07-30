import { build as bundle } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { build as buildFrontend } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "..");
const frontendDir = path.join(repoRoot, "frontend");
const frontendOutput = path.join(frontendDir, "dist", "public");
const deployOutput = path.join(frontendDir, "deploy", "dist");
const sourceRevision = (
  process.env.SOURCE_REVISION ??
  process.env.GITHUB_SHA ??
  ""
).toLowerCase();

if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
  throw new Error(
    "SOURCE_REVISION or GITHUB_SHA must be an exact 40-character Git SHA",
  );
}

process.env.PORT ??= "5173";
process.env.BASE_PATH = "/";
await buildFrontend({
  configFile: path.join(frontendDir, "vite.config.ts"),
  root: frontendDir,
});

fs.rmSync(deployOutput, { recursive: true, force: true });
fs.mkdirSync(deployOutput, { recursive: true });

await bundle({
  entryPoints: [path.join(repoRoot, "server", "immune-standalone.ts")],
  outfile: path.join(deployOutput, "immune-server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js:
      "import { createRequire as __immuneCreateRequire } from 'node:module'; " +
      "globalThis.require = globalThis.require || __immuneCreateRequire(import.meta.url);",
  },
});

fs.cpSync(frontendOutput, path.join(deployOutput, "public"), {
  recursive: true,
});
const dataOutput = path.join(deployOutput, "data", "immune");
fs.mkdirSync(dataOutput, { recursive: true });
for (const name of ["ledger.jsonl", "huklla_evidence.jsonl"]) {
  const source = path.join(repoRoot, "data", "immune", name);
  if (!fs.existsSync(source)) {
    throw new Error(`Required real IMMUNE chain file is missing: ${source}`);
  }
  fs.copyFileSync(source, path.join(dataOutput, name));
}

const manifest = {
  schema: "szl.hf-deploy-manifest/v1",
  source_repository: "szl-holdings/immune",
  source_revision: sourceRevision,
  source_path: "",
  destination: {
    repo_id: "SZLHOLDINGS/immune",
    repo_type: "space",
    mode: "standalone-runtime-whitelist",
  },
};
fs.writeFileSync(
  path.join(deployOutput, "hf-deploy-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify(
    {
      status: "BUILT",
      source_revision: sourceRevision,
      server: path.join(deployOutput, "immune-server.js"),
      frontend: path.join(deployOutput, "public"),
      ledger: dataOutput,
    },
    null,
    2,
  ),
);
