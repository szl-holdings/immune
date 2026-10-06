import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SPACES = Object.freeze(["SZLHOLDINGS/immune", "SZLHOLDINGS/immune-lattice"]);
const INPUTS = Object.freeze(["confirmation", "source_revision", "space"]);

// Source qualification is not permission to publish. Each invocation binds one
// explicitly confirmed Space to the exact main SHA; no HF credential is needed.
export function validatePublicationDispatch({ environment = process.env, event }) {
  const inputs = event?.inputs;
  const revision = environment.GITHUB_SHA;
  const space = environment.HF_SPACE;
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REPOSITORY !== "szl-holdings/immune" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision) ||
    !SPACES.includes(space) ||
    !inputs || typeof inputs !== "object" || Array.isArray(inputs) ||
    Object.keys(inputs).sort().join(",") !== INPUTS.join(",") ||
    inputs.space !== space || inputs.source_revision !== revision ||
    inputs.confirmation !== `PUBLISH ${space}@${revision}`
  ) {
    throw new Error("Publication requires one explicit exact-main Space confirmation; no provider write admitted");
  }
  return {
    schema: "szl.immune-publication-dispatch/v1",
    repository: "szl-holdings/immune",
    sourceRevision: revision,
    space,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GitHub dispatch event evidence is missing");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  console.log(JSON.stringify(validatePublicationDispatch({ event })));
}
