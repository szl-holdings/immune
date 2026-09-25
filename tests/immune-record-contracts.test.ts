// Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DecisionGenomeEventSchema,
  DecisionGenomeSchema,
  DecisionRecommendationSchema,
} from "../server/contracts/decision-genome";
import {
  buildShadowDecisionGenome,
  FrontierEvaluateSchema,
} from "../server/routes/immune/agent";

const at = "2026-09-24T12:00:00.000Z";
const digest = "a".repeat(64);
function event(payload: unknown) {
  return {
    eventId: "fixture:observation",
    eventType: "OBSERVATION",
    at,
    actor: "test:record-compatibility",
    subjectDigest: digest,
    policyVersion: "fixture-v1",
    evidenceLabel: "MODELED",
    payload,
  };
}

for (const [name, payload] of [
  ["empty", {}],
  ["heterogeneous", { text: "fixture", count: 1, enabled: false, absent: null,
    nested: { values: [1, "two"] } }],
] as const) {
  test(`admitted record contract preserves ${name} payload`, () => {
    assert.deepEqual(DecisionGenomeEventSchema.parse(event(payload)).payload, payload);
  });
}

for (const [name, payload] of [
  ["null", null], ["array", []], ["text", "fixture"],
  ["number", 1], ["boolean", true], ["missing", undefined],
] as const) {
  test(`admitted record contract rejects ${name} payload`, () => {
    assert.equal(DecisionGenomeEventSchema.safeParse(event(payload)).success, false);
  });
}

test("record compatibility does not relax subject digest validation", () => {
  assert.equal(DecisionGenomeEventSchema.safeParse({
    ...event({}), subjectDigest: "not-a-digest",
  }).success, false);
});

for (const executable of [true, "false", 0, 1, null]) {
  test(`record compatibility preserves literal-false execution boundary: ${JSON.stringify(executable)}`, () => {
    assert.equal(DecisionRecommendationSchema.safeParse({
      state: "ALLOW_OBSERVE", action: "OBSERVE", reasonCodes: ["FIXTURE"],
      humanApprovalRequired: false, executable, evidenceLabel: "MODELED",
    }).success, false);
  });
}

function observation(overrides: Record<string, unknown> = {}) {
  return FrontierEvaluateSchema.parse({
    observationId: "fixture:shadow-decision",
    subject: { kind: "fixture", id: "record-compatibility" },
    source: {
      sourceName: "synthetic-regression-fixture", observedAt: at, fetchedAt: at,
      parserVersion: "fixture-v1", rawPayloadSha256: digest,
      licenseSpdxOrTermsUrl: "Apache-2.0", distributionMarking: "SYNTHETIC_TEST",
      confidence: 0.9,
    },
    signals: {
      novelty: 0.1, dangerContext: 0.1, baselineAnomaly: 0.1,
      causalShift: 0.1, propagationRisk: 0.1,
    },
    calibrationScores: Array(20).fill(0.2),
    ...overrides,
  });
}

for (const [name, input, expected] of [
  ["bounded observation", observation(), "ALLOW_OBSERVE"],
  ["missing calibration", observation({ calibrationScores: [] }), "REVIEW_REQUIRED"],
  ["hard policy signal", observation({ signals: {
    novelty: 0.1, dangerContext: 0.1, baselineAnomaly: 0.1,
    causalShift: 0.1, propagationRisk: 0.1, hardPolicyViolation: true,
  } }), "QUARANTINE_RECOMMENDED"],
] as const) {
  test(`real shadow builder parses record events for ${name} without execution authority`, () => {
    const genome = buildShadowDecisionGenome(input, new Date(at));
    assert.equal(genome.mode, "shadow");
    assert.equal(genome.recommendation.state, expected);
    assert.equal(genome.recommendation.executable, false);
    assert.equal(genome.recommendation.evidenceLabel, "MODELED");
    assert.deepEqual(genome.events.map(item => item.eventType), ["OBSERVATION", "FUSION", "RECOMMENDATION"]);
    assert.equal(genome.events.every(item => item.evidenceLabel === "MODELED"), true);
    assert.equal(DecisionGenomeSchema.safeParse(genome).success, true);
    assert.deepEqual(buildShadowDecisionGenome(input, new Date(at)), genome);
  });
}

test("snapshot file remains byte-bound to its declared canonical source", () => {
  const source = readFileSync(new URL("../server/contracts/decision-genome.ts", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  const provenance = JSON.parse(readFileSync(new URL("../server/contracts/decision-genome.snapshot.json", import.meta.url), "utf8"));
  assert.equal(provenance.source_repository, "szl-holdings/platform");
  assert.equal(provenance.source_path, "packages/contracts/src/decision-genome.ts");
  assert.equal(provenance.source_blob_sha, "d193feb45f7e780681735efd091b1485cc2799a9");
  assert.equal(provenance.sha256, "91ca377c20a33f52be44cc810516b99bde3da6d174ae7df509df66f57f166f33");
  assert.equal(createHash("sha256").update(source, "utf8").digest("hex"), provenance.sha256);
});

test("agent-local arguments use explicit string keys without exposing a new parser API", () => {
  const source = readFileSync(new URL("../server/routes/immune/agent.ts", import.meta.url), "utf8");
  assert.equal(source.includes("args: z.record(z.string(), z.unknown()).optional()"), true);
  assert.equal(source.includes("args: z.record(z.unknown()).optional()"), false);
});
