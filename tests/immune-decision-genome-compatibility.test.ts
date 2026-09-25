// Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
// Offline schema/parser tests only: no HTTP handler, inference or governed cycle runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DecisionGenomeEventSchema,
  DecisionRecommendationSchema,
} from "../server/contracts/decision-genome";
import {
  buildShadowDecisionGenome,
  FrontierEvaluateSchema,
  parseModelStep,
} from "../server/routes/immune/agent";

const event = {
  eventId: "fixture:observation",
  eventType: "OBSERVATION",
  at: "2026-09-24T00:00:00.000Z",
  actor: "fixture:offline",
  subjectDigest: "a".repeat(64),
  inputDigests: [],
  policyVersion: "fixture-v1",
  evidenceLabel: "MODELED",
};

const recommendation = {
  state: "REVIEW_REQUIRED",
  action: "OPEN_INCIDENT",
  reasonCodes: ["CALIBRATION_SET_INSUFFICIENT"],
  humanApprovalRequired: true,
  executable: false,
  evidenceLabel: "MODELED",
};

const heterogeneous = {
  sourceState: "STALE",
  confidence: 0.5,
  missing: null,
  executable: false,
  nested: { label: "MODELED" },
  inputs: [1, "two", null],
  "0": "string key",
};

test("snapshot bytes match both declared SHA-256 and canonical Git blob", () => {
  const text = readFileSync(new URL("../server/contracts/decision-genome.ts", import.meta.url), "utf8");
  const bytes = Buffer.from(text.replace(/\r\n/gu, "\n"), "utf8");
  const snapshot = JSON.parse(readFileSync(
    new URL("../server/contracts/decision-genome.snapshot.json", import.meta.url), "utf8",
  ));
  assert.equal(snapshot.schema, "szl.contract-snapshot/v1");
  assert.equal(snapshot.source_repository, "szl-holdings/platform");
  assert.equal(snapshot.source_path, "packages/contracts/src/decision-genome.ts");
  assert.match(snapshot.source_revision, /^[0-9a-f]{40}$/u);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), snapshot.sha256);
  assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), snapshot.source_blob_sha);
});

test("event accepts an empty record", () => {
  assert.deepEqual(DecisionGenomeEventSchema.parse({ ...event, payload: {} }).payload, {});
});

test("event preserves heterogeneous values without promoting authority", () => {
  assert.deepEqual(DecisionGenomeEventSchema.parse({ ...event, payload: heterogeneous }).payload, heterogeneous);
});

for (const [label, payload] of [
  ["null", null], ["array", []], ["string", "invalid"],
  ["number", 1], ["boolean", false], ["missing", undefined],
] as const) {
  test(`event rejects outer ${label} payload`, () => {
    assert.equal(DecisionGenomeEventSchema.safeParse({ ...event, payload }).success, false);
  });
}

test("event still rejects malformed identity digests", () => {
  assert.equal(DecisionGenomeEventSchema.safeParse({ ...event, subjectDigest: "short", payload: {} }).success, false);
});

test("recommendation remains non-executable and modeled", () => {
  assert.deepEqual(DecisionRecommendationSchema.parse(recommendation), recommendation);
});

for (const [label, executable] of [
  ["true", true], ["numeric", 1], ["string", "false"], ["null", null], ["missing", undefined],
] as const) {
  test(`recommendation rejects ${label} execution authority`, () => {
    assert.equal(DecisionRecommendationSchema.safeParse({ ...recommendation, executable }).success, false);
  });
}

test("actual agent parser preserves non-empty and empty argument records", () => {
  for (const args of [heterogeneous, {}]) {
    const step = { thought: "Offline fixture", action: { tool: "immune_state", args } };
    assert.deepEqual(parseModelStep(JSON.stringify(step)), step);
  }
});

test("actual agent parser preserves optional omitted arguments", () => {
  const step = { action: { tool: "immune_state" } };
  assert.deepEqual(parseModelStep(JSON.stringify(step)), step);
});

for (const [label, args] of [
  ["null", null], ["array", []], ["string", "invalid"], ["number", 1], ["boolean", false],
] as const) {
  test(`actual agent parser rejects ${label} argument container`, () => {
    assert.equal(parseModelStep(JSON.stringify({ action: { tool: "immune_state", args } })), null);
  });
}

test("actual agent parser rejects malformed JSON", () => {
  assert.equal(parseModelStep("not JSON"), null);
});

test("existing whitespace and fence tolerance remains intact", () => {
  assert.deepEqual(parseModelStep('  ```json\n{"final":"Offline fixture"}\n```  '), { final: "Offline fixture" });
});

test("existing thought, tool and final length limits stay enforced", () => {
  for (const step of [
    { thought: "x".repeat(601) },
    { action: { tool: "x".repeat(65), args: {} } },
    { final: "x".repeat(1201) },
  ]) {
    assert.equal(parseModelStep(JSON.stringify(step)), null);
  }
});

test("actual shadow builder emits populated records without execution authority", () => {
  const now = new Date("2026-09-24T00:00:00.000Z");
  const input = FrontierEvaluateSchema.parse({
    observationId: "fixture:shadow",
    subject: { kind: "offline-fixture", id: "test-only" },
    source: {
      sourceName: "offline-fixture",
      observedAt: now.toISOString(), fetchedAt: now.toISOString(),
      parserVersion: "fixture-v1", rawPayloadSha256: "b".repeat(64),
      licenseSpdxOrTermsUrl: "Apache-2.0", distributionMarking: "SYNTHETIC", confidence: 0.8,
    },
    signals: { novelty: 0.1, dangerContext: 0.1, baselineAnomaly: 0.1, causalShift: 0.1, propagationRisk: 0.1 },
  });
  const genome = buildShadowDecisionGenome(input, now);
  assert.equal(genome.mode, "shadow");
  assert.equal(genome.events.length, 3);
  assert.equal(genome.recommendation.executable, false);
  assert.equal(genome.recommendation.evidenceLabel, "MODELED");
  assert.equal(genome.recommendation.state, "REVIEW_REQUIRED");
  assert.ok(genome.recommendation.reasonCodes.includes("CALIBRATION_SET_INSUFFICIENT"));
  assert.ok(genome.events.every((item) => Object.keys(item.payload).length > 0));
});
