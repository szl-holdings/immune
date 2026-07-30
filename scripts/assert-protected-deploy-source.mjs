const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "";
const isDeployWorkflow =
  process.env.GITHUB_ACTIONS === "true" &&
  workflowRef.includes("/.github/workflows/deploy-hf-space.yml@");

if (!isDeployWorkflow) {
  process.exit(0);
}

const repository = process.env.GITHUB_REPOSITORY;
const sourceRevision = process.env.GITHUB_SHA?.toLowerCase();
const sourceRef = process.env.GITHUB_REF;

if (!repository || !/^[0-9a-f]{40}$/u.test(sourceRevision ?? "")) {
  throw new Error("Protected deploy source identity is incomplete");
}
if (sourceRef !== "refs/heads/main") {
  throw new Error(
    `Protected deployment requires refs/heads/main; observed ${sourceRef ?? "null"}`,
  );
}

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "szl-immune-protected-deploy",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const response = await fetch(
  `https://api.github.com/repos/${repository}/git/ref/heads/main`,
  { headers },
);
if (!response.ok) {
  throw new Error(
    `Unable to resolve protected main (${response.status} ${response.statusText})`,
  );
}

const payload = await response.json();
const protectedMain = String(payload?.object?.sha ?? "").toLowerCase();
if (!/^[0-9a-f]{40}$/u.test(protectedMain)) {
  throw new Error("GitHub returned an invalid protected-main revision");
}
if (protectedMain !== sourceRevision) {
  throw new Error(
    `Refusing stale deployment: run=${sourceRevision} protected-main=${protectedMain}`,
  );
}

console.log(
  JSON.stringify({
    repository,
    ref: sourceRef,
    revision: sourceRevision,
    protected_main: protectedMain,
    status: "EXACT_MAIN",
  }),
);
