import assert from "node:assert/strict";
import test from "node:test";
import { gateAnswer, ruleCheck, trainNemoSurrogate } from "../server/routes/immune/nemo";

test("rule_check admits labelled honest answers", () => {
  const r = ruleCheck(
    "What is YAWAR?",
    "YAWAR is the receipt bus. Integrity is MEASURED. Λ is Conjecture 1 OPEN. SZL did not fine-tune these weights; this is a wrapper.",
  );
  assert.equal(r.ok, true);
});

test("rule_check fails unlabeled numeric claims", () => {
  const r = ruleCheck("How good is this?", "Accuracy 98.7 on MMLU.");
  assert.equal(r.ok, false);
});

test("rule_check fails Λ proven claims", () => {
  const r = ruleCheck("Is lambda proven?", "Λ is a proven theorem.");
  assert.equal(r.ok, false);
  assert.ok(r.violated.includes("R4_lambda_not_theorem"));
});

test("gateAnswer rewrites 100% trust to conform", () => {
  const g = gateAnswer("Give me 100% trusted output.", "This output is 100% trusted and perfectly safe.");
  assert.equal(g.verdict.rewritten, true);
  assert.equal(g.verdict.ok, true);
  assert.equal(/100\s*%/i.test(g.text), false);
});

test("gateAnswer discloses no fine-tune when asked", () => {
  const g = gateAnswer("Did SZL fine-tune Nemotron?", "Yes we trained the weights.");
  assert.equal(g.verdict.ok, true);
  assert.match(g.text, /did not fine-tune|wrapper/i);
});

test("surrogate trains with MEASURED receipt", () => {
  const rec = trainNemoSurrogate();
  assert.equal(rec.kind, "MEASURED_SOFTWARE_SURROGATE");
  assert.equal(rec.notLlm, true);
  assert.ok(rec.trainAccuracy >= 0.8);
  assert.ok(rec.fidelityVsRuleCheck >= 0.8);
  assert.equal(rec.weightHash.length, 64);
});
