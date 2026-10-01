import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACTION_ENVELOPE_VERSION } from "../server/routes/immune/state";

// Retain the existing package-script entrypoint as a retirement regression.
// It must never restore the deleted in-Space demo signing capability.
test("the production demo signer is retired and the authority contract is v2 only", () => {
  const root = path.resolve(import.meta.dirname, "..");
  assert.equal(ACTION_ENVELOPE_VERSION, "immune.action.v2");
  assert.equal(fs.existsSync(path.join(root, "server/routes/immune/demo-operator.ts")), false);
  const runtime = fs.readFileSync(path.join(root, "server/immune-standalone.ts"), "utf8");
  assert.doesNotMatch(runtime, /bootDemoOperator|loadDemoOperatorIdentity|signOperatorAction/);
  assert.doesNotMatch(runtime, /IMMUNE_ACTION_PRIVATE_KEY|IMMUNE_ACTION_SIGNING_PKCS8_B64/);
});

test("the hosted source gate includes every source regression without changing package manifests", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const file of ["ci.yml", "deploy-hf-space.yml"]) {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
    assert.ok(workflow.includes("pnpm exec tsx --test tests/*.test.ts"), file);
    assert.ok(workflow.includes("pnpm install --frozen-lockfile"), file);
  }
});
