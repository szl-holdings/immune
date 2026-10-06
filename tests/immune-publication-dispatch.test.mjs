import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validatePublicationDispatch } from "../scripts/require-publication-dispatch.mjs";

const revision = "a".repeat(40);
const spaces = ["SZLHOLDINGS/immune", "SZLHOLDINGS/immune-lattice"];
const fixture = (space = spaces[0]) => ({
  environment: {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "szl-holdings/immune",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: revision,
    HF_SPACE: space,
  },
  event: {
    inputs: {
      space,
      source_revision: revision,
      confirmation: `PUBLISH ${space}@${revision}`,
    },
  },
});

for (const space of spaces) {
  test(`one explicit exact-source dispatch admits only ${space}`, () => {
    const input = fixture(space);
    assert.deepEqual(validatePublicationDispatch(input), {
      schema: "szl.immune-publication-dispatch/v1",
      repository: "szl-holdings/immune",
      sourceRevision: revision,
      space,
    });
    input.environment.HF_SPACE = spaces.find((other) => other !== space);
    assert.throws(() => validatePublicationDispatch(input));
  });
}

for (const [name, change] of [
  ["push", (x) => { x.environment.GITHUB_EVENT_NAME = "push"; }],
  ["pull request", (x) => { x.environment.GITHUB_EVENT_NAME = "pull_request"; }],
  ["tag", (x) => { x.environment.GITHUB_REF = "refs/tags/release"; }],
  ["non-main branch", (x) => { x.environment.GITHUB_REF = "refs/heads/staging"; }],
  ["different repository", (x) => { x.environment.GITHUB_REPOSITORY = "other/immune"; }],
  ["missing SHA", (x) => { delete x.environment.GITHUB_SHA; }],
  ["malformed SHA", (x) => { x.environment.GITHUB_SHA = "abc"; }],
  ["old source", (x) => { x.event.inputs.source_revision = "b".repeat(40); }],
  ["unknown target", (x) => { x.event.inputs.space = "SZLHOLDINGS/other"; }],
  ["default target", (x) => { x.event.inputs.space = "NONE"; }],
  ["missing confirmation", (x) => { delete x.event.inputs.confirmation; }],
  ["ambiguous confirmation", (x) => { x.event.inputs.confirmation = "yes"; }],
  ["wrong confirmation target", (x) => { x.event.inputs.confirmation = `PUBLISH ${spaces[1]}@${revision}`; }],
  ["unknown input", (x) => { x.event.inputs.bypass = true; }],
  ["null event", (x) => { x.event = null; }],
  ["array inputs", (x) => { x.event.inputs = []; }],
]) {
  test(`refuses ${name} before any provider credential is needed`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => validatePublicationDispatch(input));
  });
}

test("workflow is manual-only, single-target, and guards both credential boundaries", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy-hf-space.yml"), "utf8");
  const trigger = workflow.split("\non:\n")[1].split("\npermissions:")[0];
  assert.deepEqual([...trigger.matchAll(/^  ([\w]+):/gm)].map((match) => match[1]), ["workflow_dispatch"]);
  assert.match(trigger, /default: NONE/);
  for (const [index, job] of ["channel-a", "channel-b"].entries()) {
    const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  channel-[ab]:\n/)[0];
    assert.ok(body.includes(`if: github.event_name == 'workflow_dispatch' && inputs.space == '${spaces[index]}'`));
    const admission = body.indexOf("node scripts/require-publication-dispatch.mjs");
    const exactCi = body.indexOf("node scripts/require-exact-ci-success.mjs");
    const credential = body.indexOf("HF_TOKEN: ${{ secrets.HF_TOKEN }}");
    assert.ok(admission >= 0 && exactCi > admission && credential > exactCi, job);
    assert.match(body, /persist-credentials: false/);
    assert.match(body, /ref: \$\{\{ github.sha \}\}/);
  }
  const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node --test tests\/immune-publication-dispatch.test.mjs/);
});
