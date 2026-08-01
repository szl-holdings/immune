// The LIVE governed agent.
//
// A real LLM (SZL's own inference) is asked to pursue a visitor's GOAL one step
// at a time. EVERY proposed action is put through the SAME governed cycle as the
// manual demo — SENTRA gate -> signed YAWAR receipt -> HUKLLA tripwires. Only if
// the cycle PASSES is the action's (read-only, real) tool actually executed and
// its observation fed back to the model. If SENTRA rejects, a tripwire fires, or
// DEADMAN is engaged, the run stops and says so. Nothing is fabricated:
//   * tools are REAL read-only introspection of IMMUNE itself (labeled LIVE),
//   * receipts are the real signed hash-chain entries,
//   * if inference is unconfigured/unreachable the endpoint returns an honest 503.
import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ActionClassSchema,
  DECISION_GENOME_SCHEMA_ID,
  DecisionGenomeEventSchema,
  DecisionGenomeSchema,
  DecisionRecommendationSchema,
  DecisionScoreSchema,
  DecisionSourceSchema,
  type ActionClass,
  type DecisionGenome,
  type DecisionState,
  type SourceState,
} from "../../contracts/decision-genome";
import { CycleReadinessError, runGovernedCycle } from "./cycle";
import { readinessStatus, type ImmuneReadiness } from "../../readiness";
import { getState, type AuthoritySnapshot, type EvidenceState } from "./state";
import { ledgerCount, ledgerLastHash, verifyLedger } from "./ledger";
import { HUKLLA_REGISTRY } from "./huklla";
import { listSentraSignatures } from "./sentra";
import { signingEnabled } from "./signing";
import { chatComplete, inferenceConfigured, inferenceInfo, type ChatMessage } from "./inference";

const MAX_STEPS = 5;
const MAX_GOAL_LEN = 500;
const MAX_TOKENS = 400;

function requireWriteReadiness(res: Response): boolean {
  const readiness = readinessStatus();
  if (readiness.write_ready) return true;
  res.status(503).json({
    error: "WRITE_NOT_READY",
    blockers: readiness.blockers,
  });
  return false;
}

// ---- Real, read-only tools. Each returns LIVE data about IMMUNE itself. ----
type ToolFn = (args: Record<string, unknown>) => {
  provenance: "LIVE" | EvidenceState;
  data: unknown;
};

const TOOLS: Record<string, { desc: string; run: ToolFn }> = {
  immune_state: {
    desc: "Current IMMUNE mode + whether DEADMAN is engaged.",
    run: () => {
      const s = getState();
      return {
        provenance: s.evidenceState,
        data: {
          mode: s.mode,
          deadman: s.deadman,
          tripwire: s.tripwire,
          evidenceState: s.evidenceState,
          reason: s.reason,
          receiptHash: s.authorityReceiptHash,
        },
      };
    },
  },
  ledger_stats: {
    desc: "Count of receipts in the YAWAR chain and the latest hash.",
    run: () => ({ provenance: "LIVE", data: { count: ledgerCount(), lastHash: ledgerLastHash() } }),
  },
  ledger_verify: {
    desc: "Recompute the whole hash chain and report if it is intact.",
    run: () => {
      const r = verifyLedger();
      return { provenance: "LIVE", data: { ok: r.ok, count: r.count, issues: r.issues.length, firstBadSeq: r.firstBadSeq } };
    },
  },
  list_tripwires: {
    desc: "The HUKLLA tripwire registry (id, name, severity).",
    run: () => ({
      provenance: "LIVE",
      data: HUKLLA_REGISTRY.map((t) => ({ id: t.id, name: t.name, severity: t.severity })),
    }),
  },
  list_signatures: {
    desc: "The SENTRA admission signatures the gate enforces.",
    run: () => ({ provenance: "LIVE", data: listSentraSignatures() }),
  },
};

const TOOL_NAMES = Object.keys(TOOLS);

function systemPrompt(): string {
  const toolLines = Object.entries(TOOLS)
    .map(([name, t]) => `  - ${name}: ${t.desc}`)
    .join("\n");
  return [
    "You are a governed AI agent operating INSIDE the IMMUNE verifiable-AI defense matrix.",
    "Every action you propose is inspected by the SENTRA gate, sealed into a signed SHA-256",
    "receipt chain (YAWAR), and watched by HUKLLA tripwires BEFORE it can run. You cannot",
    "bypass this. Pursue the user's goal using ONLY these real read-only tools:",
    toolLines,
    "",
    "Respond with STRICT JSON and nothing else. Either propose the next action:",
    '  {"thought": "<short reasoning>", "action": {"tool": "<tool name>", "args": {}}}',
    "or finish when you have enough information:",
    '  {"thought": "<short reasoning>", "final": "<concise answer for the user>"}',
    "Rules: pick exactly one tool per step; keep thoughts to one sentence; never invent tool",
    "results — you will be given the real observation after each accepted action; do not wrap",
    "the JSON in markdown fences.",
  ].join("\n");
}

const StepSchema = z.object({
  thought: z.string().max(600).optional(),
  action: z
    .object({ tool: z.string().max(64), args: z.record(z.unknown()).optional() })
    .optional(),
  final: z.string().max(1200).optional(),
});

function parseModelStep(raw: string): z.infer<typeof StepSchema> | null {
  let text = raw.trim();
  // Tolerate accidental markdown fences without inventing content.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const brace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (brace >= 0 && lastBrace > brace) text = text.slice(brace, lastBrace + 1);
  try {
    const obj = JSON.parse(text);
    const parsed = StepSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- Lightweight cost/abuse control (no external deps) ----
const PER_IP_WINDOW_MS = 60_000;
const PER_IP_MAX = 3; // runs / minute / ip
const GLOBAL_DAILY_MAX = 300; // runs / day (all visitors)
let concurrent = 0;
const MAX_CONCURRENT = 2;
const ipHits = new Map<string, number[]>();
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function rateCheck(ip: string): { ok: true } | { ok: false; reason: string; retryAfter?: number } {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  if (dayCount >= GLOBAL_DAILY_MAX) {
    return { ok: false, reason: "daily demo budget reached — try again tomorrow" };
  }
  if (concurrent >= MAX_CONCURRENT) {
    return { ok: false, reason: "the governed agent is busy — try again in a moment", retryAfter: 5 };
  }
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (hits.length >= PER_IP_MAX) {
    return { ok: false, reason: "rate limit: max 3 agent runs per minute", retryAfter: 30 };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount++;
  return { ok: true };
}

export type AgentStatusView = {
  available: boolean;
  provenance: "LIVE" | "UNAVAILABLE";
  blockers: string[];
  inference: ReturnType<typeof inferenceInfo>;
  readiness: Pick<ImmuneReadiness, "status" | "write_ready">;
  authority: {
    evidenceState: EvidenceState;
    reason: string;
    receiptHash: string | null;
  };
  signing: "ed25519" | "hash-only";
  tools: string[];
  maxSteps: number;
  note: string;
};

export type AgentStatusDependencies = {
  inferenceInfo: () => ReturnType<typeof inferenceInfo>;
  readinessStatus: () => ImmuneReadiness;
  getState: () => AuthoritySnapshot;
  signingEnabled: () => boolean;
};

const DEFAULT_AGENT_STATUS_DEPENDENCIES: AgentStatusDependencies = {
  inferenceInfo,
  readinessStatus,
  getState,
  signingEnabled,
};

export function agentStatus(
  dependencies: AgentStatusDependencies = DEFAULT_AGENT_STATUS_DEPENDENCIES,
): AgentStatusView {
  const inf = dependencies.inferenceInfo();
  const readiness = dependencies.readinessStatus();
  const authority = dependencies.getState();
  const available = inf.configured && readiness.write_ready;
  const blockers = [
    ...(inf.configured ? [] : ["INFERENCE_UNCONFIGURED"]),
    ...readiness.blockers,
  ];
  return {
    available,
    provenance: available ? "LIVE" : "UNAVAILABLE",
    blockers: [...new Set(blockers)],
    inference: inf,
    readiness: {
      status: readiness.status,
      write_ready: readiness.write_ready,
    },
    authority: {
      evidenceState: authority.evidenceState,
      reason: authority.reason,
      receiptHash: authority.authorityReceiptHash,
    },
    signing: dependencies.signingEnabled() ? "ed25519" : "hash-only",
    tools: TOOL_NAMES,
    maxSteps: MAX_STEPS,
    note: available
      ? "Live governed agent ready — every action is SENTRA-gated and receipted."
      : !inf.configured
        ? "Governed agent unavailable because inference is not configured."
        : `Governed agent unavailable until the full server write-readiness contract is satisfied: ${readiness.blockers.join(", ")}.`,
  };
}

const router: IRouter = Router();

const FRONTIER_POLICY_VERSION = "immune-frontier-v1";
const SOURCE_CLOCK_SKEW_MS = 5 * 60_000;

export const FrontierEvaluateSchema = z.object({
  observationId: z.string().min(1).max(256),
  subject: z.object({
    kind: z.string().min(1).max(128),
    id: z.string().min(1).max(512),
  }),
  source: DecisionSourceSchema.omit({ state: true }).extend({
    licenseSpdxOrTermsUrl: z.string().min(1).max(1024),
  }),
  signals: z.object({
    novelty: z.number().min(0).max(1),
    dangerContext: z.number().min(0).max(1),
    baselineAnomaly: z.number().min(0).max(1),
    causalShift: z.number().min(0).max(1),
    propagationRisk: z.number().min(0).max(1),
    hardPolicyViolation: z.boolean().default(false),
  }),
  calibrationScores: z.array(z.number().min(0).max(1)).max(10_000).default([]),
  alpha: DecisionScoreSchema.shape.falseAlertBudgetAlpha.lt(0.5).default(0.05),
});
export type FrontierEvaluateInput = z.infer<typeof FrontierEvaluateSchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function decisionSourceState(
  source: FrontierEvaluateInput["source"],
  nowMs = Date.now(),
): {
  state: SourceState;
  ageMinutes: number | null;
} {
  const observed = Date.parse(source.observedAt);
  const fetched = Date.parse(source.fetchedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(fetched)) {
    return { state: "UNAVAILABLE", ageMinutes: null };
  }
  if (
    observed - fetched > SOURCE_CLOCK_SKEW_MS ||
    observed - nowMs > SOURCE_CLOCK_SKEW_MS ||
    fetched - nowMs > SOURCE_CLOCK_SKEW_MS
  ) {
    return { state: "CONFLICTED", ageMinutes: (nowMs - observed) / 60_000 };
  }
  const ageMinutes = Math.max(0, (nowMs - observed) / 60_000);
  if (source.expiresAt && Date.parse(source.expiresAt) <= nowMs) {
    return { state: ageMinutes <= 240 ? "STALE" : "DEGRADED", ageMinutes };
  }
  if (ageMinutes <= 5) return { state: "LIVE", ageMinutes };
  if (ageMinutes <= 60) return { state: "CACHED", ageMinutes };
  if (ageMinutes <= 240) return { state: "STALE", ageMinutes };
  return { state: "DEGRADED", ageMinutes };
}

export function conformalPValue(score: number, calibrationScores: number[]): number | null {
  if (calibrationScores.length < 20) return null;
  const atLeastAsAnomalous = calibrationScores.filter((item) => item >= score).length;
  return (1 + atLeastAsAnomalous) / (calibrationScores.length + 1);
}

export function buildShadowDecisionGenome(
  input: FrontierEvaluateInput,
  now = new Date(),
): DecisionGenome {
  const freshness = decisionSourceState(input.source, now.getTime());
  const compositeRisk =
    0.25 * input.signals.novelty +
    0.30 * input.signals.dangerContext +
    0.20 * input.signals.baselineAnomaly +
    0.15 * input.signals.causalShift +
    0.10 * input.signals.propagationRisk;
  const pValue = conformalPValue(compositeRisk, input.calibrationScores);
  const freshnessDebt = ["STALE", "DEGRADED", "UNAVAILABLE", "CONFLICTED"].includes(freshness.state)
    ? 0.35
    : freshness.state === "CACHED"
      ? 0.1
      : 0;
  const uncertainty = Math.min(
    1,
    0.55 * (1 - input.source.confidence) + freshnessDebt + (pValue === null ? 0.2 : 0),
  );

  let state: DecisionState;
  let action: ActionClass;
  const reasonCodes: string[] = [];

  if (
    input.source.confidence < 0.5 ||
    ["STALE", "DEGRADED", "UNAVAILABLE", "CONFLICTED"].includes(freshness.state)
  ) {
    state = "WITHHOLD";
    action = freshness.state === "STALE" ? "REQUEST_READ_ONLY_PROBE" : "OPEN_INCIDENT";
    reasonCodes.push("PROVENANCE_OR_FRESHNESS_GATE");
    if (input.signals.hardPolicyViolation) reasonCodes.push("HARD_POLICY_SIGNAL");
  } else if (input.signals.hardPolicyViolation) {
    state = "QUARANTINE_RECOMMENDED";
    action = "REQUEST_QUARANTINE_REVIEW";
    reasonCodes.push("HARD_POLICY_SIGNAL");
  } else if (pValue === null) {
    state = "REVIEW_REQUIRED";
    action = "OPEN_INCIDENT";
    reasonCodes.push("CALIBRATION_SET_INSUFFICIENT");
  } else if (pValue <= input.alpha && compositeRisk >= 0.85) {
    state = "QUARANTINE_RECOMMENDED";
    action = "REQUEST_QUARANTINE_REVIEW";
    reasonCodes.push("CONFORMAL_ALERT", "HIGH_COMPOSITE_RISK");
  } else if (pValue <= input.alpha || compositeRisk >= 0.65) {
    state = "REVIEW_REQUIRED";
    action = "OPEN_INCIDENT";
    reasonCodes.push(pValue <= input.alpha ? "CONFORMAL_ALERT" : "ELEVATED_COMPOSITE_RISK");
  } else {
    state = "ALLOW_OBSERVE";
    action = "OBSERVE";
    reasonCodes.push("SHADOW_OBSERVATION_ONLY");
  }

  const at = now.toISOString();
  const subjectDigest = sha256(input.subject);
  const source = DecisionSourceSchema.parse({ ...input.source, state: freshness.state });
  const recommendation = DecisionRecommendationSchema.parse({
    state,
    action: ActionClassSchema.parse(action),
    reasonCodes,
    humanApprovalRequired: action !== "OBSERVE",
    executable: false,
    evidenceLabel: "MODELED",
  });
  const scores = DecisionScoreSchema.parse({
    novelty: input.signals.novelty,
    dangerContext: input.signals.dangerContext,
    baselineAnomaly: input.signals.baselineAnomaly,
    causalShift: input.signals.causalShift,
    propagationRisk: input.signals.propagationRisk,
    compositeRisk,
    conformalPValue: pValue,
    falseAlertBudgetAlpha: input.alpha,
    uncertainty,
  });
  const eventBase = {
    at,
    actor: "immune:frontier-shadow",
    subjectDigest,
    policyVersion: FRONTIER_POLICY_VERSION,
    evidenceLabel: "MODELED" as const,
  };
  const events = DecisionGenomeEventSchema.array().parse([
    {
      ...eventBase,
      eventId: `${input.observationId}:observation`,
      eventType: "OBSERVATION",
      inputDigests: [source.rawPayloadSha256],
      payload: {
        sourceState: source.state,
        sourceConfidence: source.confidence,
        sourceAgeMinutes: freshness.ageMinutes,
      },
    },
    {
      ...eventBase,
      eventId: `${input.observationId}:fusion`,
      eventType: "FUSION",
      inputDigests: [source.rawPayloadSha256],
      payload: scores,
    },
    {
      ...eventBase,
      eventId: `${input.observationId}:recommendation`,
      eventType: "RECOMMENDATION",
      inputDigests: [sha256(scores)],
      payload: recommendation,
    },
  ]);
  const genomeWithoutDigest = {
    schemaId: DECISION_GENOME_SCHEMA_ID,
    decisionId: input.observationId,
    createdAt: at,
    mode: "shadow" as const,
    subject: { ...input.subject, digest: subjectDigest },
    sources: [source],
    scores,
    recommendation,
    events,
  };
  return DecisionGenomeSchema.parse({
    ...genomeWithoutDigest,
    digest: sha256(genomeWithoutDigest),
  });
}

router.get("/frontier", (_req: Request, res: Response) => {
  res.json({
    service: "immune-decision-genome",
    version: "v1",
    mode: "shadow",
    schemaId: DECISION_GENOME_SCHEMA_ID,
    evidenceLabel: "MODELED",
    executable: false,
    kernels: [
      "negative-selection novelty",
      "danger-context aggregation",
      "causal mechanism shift",
      "graph propagation risk",
      "conformal false-alert control",
      "provenance and freshness gate",
    ],
    outputs: ["ALLOW_OBSERVE", "REVIEW_REQUIRED", "QUARANTINE_RECOMMENDED", "WITHHOLD"],
    invariant:
      "No destructive action is emitted. Missing provenance, stale evidence, or insufficient calibration cannot become a green claim.",
  });
});

router.post("/frontier/evaluate", async (req: Request, res: Response) => {
  const parsed = FrontierEvaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_decision_observation",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return;
  }

  const input = parsed.data;
  if (!requireWriteReadiness(res)) return;
  const ip = req.ip || "unknown";
  const gate = rateCheck(ip);
  if (!gate.ok) {
    if (gate.retryAfter) res.set("Retry-After", String(gate.retryAfter));
    res.status(429).json({ error: gate.reason });
    return;
  }

  const genome = buildShadowDecisionGenome(input);
  let cycle;
  try {
    cycle = await runGovernedCycle(
      { actor: "immune:frontier-shadow", intent: "seal defensive shadow recommendation" },
      {
        schemaId: genome.schemaId,
        decisionId: genome.decisionId,
        genomeDigest: genome.digest,
        subjectDigest: genome.subject.digest,
        policyVersion: FRONTIER_POLICY_VERSION,
        recommendation: {
          state: genome.recommendation.state,
          action: genome.recommendation.action,
          executable: genome.recommendation.executable,
          evidenceLabel: genome.recommendation.evidenceLabel,
        },
      },
    );
  } catch (error) {
    if (error instanceof CycleReadinessError) {
      res.status(503).json({ error: "WRITE_NOT_READY", blockers: error.blockers });
      return;
    }
    throw error;
  }

  res.status(cycle.pass ? 200 : 409).json({
    genome,
    governance: {
      pass: cycle.pass,
      sentra: cycle.sentra,
      firedTripwires: cycle.huklla.filter((item) => item.fired),
      receipt: cycle.receipt
        ? {
            seq: cycle.receipt.seq,
            hash: cycle.receipt.hash,
            prevHash: cycle.receipt.prevHash,
            signed: Boolean(cycle.receipt.sig),
            kid: cycle.receipt.kid ?? null,
          }
        : null,
    },
  });
});

router.get("/status", (_req: Request, res: Response) => {
  res.json(agentStatus());
});

router.post("/run", async (req: Request, res: Response) => {
  if (!inferenceConfigured()) {
    res.status(503).json({
      error: "inference UNAVAILABLE",
      provenance: "UNAVAILABLE",
      detail: "No inference endpoint is configured on this deployment.",
    });
    return;
  }

  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "a non-empty 'goal' is required" });
    return;
  }
  if (goal.length > MAX_GOAL_LEN) {
    res.status(400).json({ error: `goal exceeds ${MAX_GOAL_LEN} characters` });
    return;
  }
  if (!requireWriteReadiness(res)) return;

  const ip = req.ip || "unknown";
  const gate = rateCheck(ip);
  if (!gate.ok) {
    if (gate.retryAfter) res.set("Retry-After", String(gate.retryAfter));
    res.status(429).json({ error: gate.reason });
    return;
  }

  concurrent++;
  const startedAt = new Date().toISOString();
  const steps: any[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: `Goal: ${goal}` },
  ];
  let finalText: string | null = null;
  let blocked = false;
  let stoppedReason = "reached step cap";
  let malformedRetried = false;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    for (let n = 1; n <= MAX_STEPS; n++) {
      // DEADMAN can be engaged mid-run — honor it before spending on inference.
      if (getState().deadman) {
        blocked = true;
        stoppedReason = "DEADMAN engaged — agent frozen";
        break;
      }

      let completion;
      try {
        completion = await chatComplete(messages, { maxTokens: MAX_TOKENS });
      } catch (err) {
        stoppedReason = `inference error: ${(err as Error).message}`;
        blocked = true;
        break;
      }
      if (completion.usage) {
        usage.promptTokens += completion.usage.promptTokens ?? 0;
        usage.completionTokens += completion.usage.completionTokens ?? 0;
        usage.totalTokens += completion.usage.totalTokens ?? 0;
      }
      messages.push({ role: "assistant", content: completion.content });

      const parsedStep = parseModelStep(completion.content);
      if (!parsedStep) {
        if (!malformedRetried) {
          malformedRetried = true;
          messages.push({
            role: "user",
            content: "Your last message was not valid JSON. Reply with ONLY the JSON object described.",
          });
          continue;
        }
        blocked = true;
        stoppedReason = "blocked: model did not return valid JSON";
        break;
      }

      if (parsedStep.final !== undefined && !parsedStep.action) {
        finalText = parsedStep.final;
        stoppedReason = "agent completed the goal";
        break;
      }

      const tool = parsedStep.action?.tool ?? "";
      const args = parsedStep.action?.args ?? {};
      const thought = parsedStep.thought ?? "";

      // Govern the PROPOSED action through the real cycle.
      const cycle = await runGovernedCycle(
        { actor: "agent:immune-demo", intent: `agent action: ${tool}` },
        { goal, step: n, tool, args, thought },
      );

      const stepOut: any = {
        n,
        thought,
        tool,
        args,
        sentra: cycle.sentra,
        huklla: cycle.huklla.filter((t) => t.fired),
        receipt: cycle.receipt
          ? {
              seq: cycle.receipt.seq,
              hash: cycle.receipt.hash,
              prevHash: cycle.receipt.prevHash,
              signed: Boolean(cycle.receipt.sig),
              kid: cycle.receipt.kid ?? null,
            }
          : null,
        pass: cycle.pass,
      };

      if (!cycle.pass) {
        stepOut.observation = { provenance: "LIVE", blocked: true, reason: cycle.sentra.reason };
        steps.push(stepOut);
        blocked = true;
        stoppedReason = cycle.deadman
          ? "DEADMAN engaged — agent frozen"
          : `SENTRA blocked the action (${cycle.sentra.signatureMatched ?? "gate"})`;
        break;
      }

      // Accepted + receipted -> execute the REAL tool (or honestly report unknown).
      let observation: unknown;
      if (TOOLS[tool]) {
        observation = TOOLS[tool].run(args as Record<string, unknown>);
      } else {
        observation = {
          provenance: "LIVE",
          error: "tool_not_available",
          available: TOOL_NAMES,
        };
      }
      stepOut.observation = observation;
      steps.push(stepOut);

      messages.push({
        role: "user",
        content: `Observation (LIVE) for ${tool}: ${JSON.stringify(observation)}`,
      });
    }
  } catch (error) {
    if (error instanceof CycleReadinessError) {
      blocked = true;
      stoppedReason = `write readiness lost: ${error.blockers.join(", ")}`;
    } else {
      throw error;
    }
  } finally {
    concurrent = Math.max(0, concurrent - 1);
  }

  res.json({
    goal,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    finalText,
    blocked,
    stoppedReason,
    usage,
    signing: signingEnabled() ? "ed25519" : "hash-only",
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
    provider: inferenceInfo().provider,
    model: inferenceInfo().model,
  });
});

export default router;
