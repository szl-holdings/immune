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
import { z } from "zod";
import { runGovernedCycle } from "./cycle";
import { getState } from "./state";
import { ledgerCount, ledgerLastHash, verifyLedger } from "./ledger";
import { HUKLLA_REGISTRY } from "./huklla";
import { listSentraSignatures } from "./sentra";
import { signingEnabled } from "./signing";
import { chatComplete, inferenceConfigured, inferenceInfo, type ChatMessage } from "./inference";

const MAX_STEPS = 5;
const MAX_GOAL_LEN = 500;
const MAX_TOKENS = 400;

// ---- Real, read-only tools. Each returns LIVE data about IMMUNE itself. ----
type ToolFn = (args: Record<string, unknown>) => { provenance: "LIVE"; data: unknown };

const TOOLS: Record<string, { desc: string; run: ToolFn }> = {
  immune_state: {
    desc: "Current IMMUNE mode + whether DEADMAN is engaged.",
    run: () => {
      const s = getState();
      return { provenance: "LIVE", data: { mode: s.mode, deadman: s.deadman, tripwire: s.tripwire } };
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
  return { ok: true };
}

export function agentStatus(): Record<string, unknown> {
  const inf = inferenceInfo();
  return {
    available: inf.configured,
    provenance: inf.configured ? "LIVE" : "UNAVAILABLE",
    inference: inf,
    signing: signingEnabled() ? "ed25519" : "hash-only",
    tools: TOOL_NAMES,
    maxSteps: MAX_STEPS,
    note: inf.configured
      ? "Live governed agent ready — every action is SENTRA-gated and receipted."
      : "Inference is not configured on this deployment; the governed cycle above still runs manually.",
  };
}

const router: IRouter = Router();

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
