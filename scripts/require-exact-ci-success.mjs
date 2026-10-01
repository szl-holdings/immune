import { pathToFileURL } from "node:url";

const REPOSITORY = "szl-holdings/immune";
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const REQUIRED_PUSH_WORKFLOWS = Object.freeze([
  "ci.yml",
  "codeql.yml",
  "lockfile-registry.yml",
  "sbom.yml",
  "scorecard.yml",
  "trivy.yml",
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function githubJson(fetchImpl, token, path) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "szl-immune-exact-ci-gate/v1",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub CI gate request failed: HTTP ${response.status}`);
  }
  return response.json();
}

export async function requireExactCiSuccess({
  fetchImpl = fetch,
  sleep = delay,
  environment = process.env,
} = {}) {
  const repository = String(environment.GITHUB_REPOSITORY ?? "").toLowerCase();
  const revision = String(environment.GITHUB_SHA ?? "").toLowerCase();
  const token = String(environment.GITHUB_TOKEN ?? "");
  const attempts = Number(environment.CI_WAIT_ATTEMPTS ?? "90");
  if (
    repository !== REPOSITORY ||
    !REVISION_PATTERN.test(revision) ||
    !token ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 120
  ) {
    throw new Error("exact CI gate configuration is invalid");
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const main = await githubJson(
      fetchImpl,
      token,
      `/repos/${REPOSITORY}/commits/main`,
    );
    if (String(main.sha ?? "").toLowerCase() !== revision) {
      throw new Error("protected main drifted while waiting for exact-head CI");
    }
    const observations = await Promise.all(
      REQUIRED_PUSH_WORKFLOWS.map(async (workflow) => {
        const query = new URLSearchParams({
          branch: "main",
          event: "push",
          head_sha: revision,
          per_page: "20",
        });
        const payload = await githubJson(
          fetchImpl,
          token,
          `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`,
        );
        const runs = Array.isArray(payload.workflow_runs)
          ? payload.workflow_runs
              .filter(
                (run) =>
                  String(run.head_sha ?? "").toLowerCase() === revision &&
                  run.head_branch === "main" &&
                  run.event === "push",
              )
              .sort(
                (left, right) =>
                  Date.parse(String(right.created_at ?? "")) -
                  Date.parse(String(left.created_at ?? "")),
              )
          : [];
        return { workflow, run: runs[0] };
      }),
    );
    const terminalFailure = observations.find(
      ({ run }) =>
        run?.status === "completed" && run.conclusion !== "success",
    );
    if (terminalFailure) {
      throw new Error(
        `exact-head ${terminalFailure.workflow} is terminal ${String(terminalFailure.run.conclusion ?? "unknown")}`,
      );
    }
    if (
      observations.every(
        ({ run }) => run?.status === "completed" && run.conclusion === "success",
      )
    ) {
      const mainAfter = await githubJson(
        fetchImpl,
        token,
        `/repos/${REPOSITORY}/commits/main`,
      );
      if (String(mainAfter.sha ?? "").toLowerCase() !== revision) {
        throw new Error("protected main drifted after exact-head CI succeeded");
      }
      return {
        schema: "szl.immune-exact-ci/v2",
        repository: REPOSITORY,
        revision,
        conclusion: "success",
        workflows: observations.map(({ workflow, run }) => ({
          path: `.github/workflows/${workflow}`,
          runId: run.id,
          runAttempt: run.run_attempt,
          conclusion: run.conclusion,
        })),
      };
    }
    if (attempt + 1 < attempts) await sleep(10_000);
  }
  throw new Error("exact-head CI did not reach terminal success before timeout");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(JSON.stringify(await requireExactCiSuccess()));
}
