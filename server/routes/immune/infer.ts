import type { Request, Response, IRouter } from "express";
import { Router } from "express";
import { z } from "zod";
import { runGovernedCycle, CycleReadinessError } from "./cycle";
import { chatComplete, inferenceConfigured, inferenceInfo } from "./inference";
import { ensureNemoTrained, gateAnswer, nemoStatus } from "./nemo";
import { ledgerCount, ledgerLastHash } from "./ledger";

const InferBody = z.object({
  prompt: z.string().trim().min(4).max(500),
});

const SYSTEM = [
  "You are the IMMUNE governed agent change management surface for SZL Holdings.",
  "szl-nemo is SOFTWARE/SURROGATE doctrine rule_check (R1–R5), not an LLM and not NVIDIA NeMo.",
  "You are a wrapper. SZL did not fine-tune your weights.",
  "Every numeric or benchmark claim MUST carry MEASURED, REPORTED, MODELED, HEURISTIC, UNKNOWN, or UNAVAILABLE.",
  "Never name Λ as proven, certified, or guaranteed. Λ is Conjecture 1 OPEN.",
  "Never claim 100%, perfect trust, or complete trust. Trust ceiling 0.97.",
  "If you do not know, say UNKNOWN. Energy is UNAVAILABLE unless a joule is measured.",
].join(" ");

function localCompose(prompt: string): string {
  const asksFt = /\b(fine[- ]?tun[a-z]*|train(?:ed)? (?:the|your|its) weights|did szl train|whose weights)\b/i.test(
    prompt,
  );
  const asksBench = /\b(benchmark|how good|quality|score|accuracy|mmlu|how well|performance)\b/i.test(prompt);
  return [
    "Governed compose (SOFTWARE, not an LLM, not Nemotron).",
    "YAWAR is the append-only SHA-256 receipt bus. SENTRA admits. HUKLLA watches.",
    asksFt
      ? "SZL did not fine-tune these weights. szl-nemo is a wrapper / system-prompt doctrine checker, not an SZL fine-tune."
      : "",
    asksBench
      ? "LLM benchmarks are UNKNOWN. Organ-probe silhouette metrics, when present, are MEASURED. Energy UNAVAILABLE."
      : "Energy UNAVAILABLE. Λ is Conjecture 1 OPEN.",
    "Honesty footer: Λ is Conjecture 1 OPEN. Energy UNAVAILABLE. Trust ceiling 0.97. SZL did not fine-tune these weights — this is a governed wrapper, not an SZL fine-tune.",
  ]
    .filter(Boolean)
    .join(" ");
}

const router: IRouter = Router();

router.get("/nemo", (_req: Request, res: Response) => {
  res.json(nemoStatus());
});

router.post("/infer", async (req: Request, res: Response) => {
  const parsed = InferBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    return;
  }
  const prompt = parsed.data.prompt;
  ensureNemoTrained();

  let cycle;
  try {
    cycle = await runGovernedCycle(
      { actor: "immune:nemo-infer", intent: `governed agent change management: ${prompt.slice(0, 180)}` },
      { gate: "szl-nemo", rules: "R1-R5" },
    );
  } catch (error) {
    if (error instanceof CycleReadinessError) {
      res.status(503).json({ error: "WRITE_NOT_READY", blockers: error.blockers });
      return;
    }
    throw error;
  }

  if (!cycle.pass) {
    res.json({
      prompt,
      answer: "",
      blocked: true,
      stoppedReason: cycle.deadman
        ? "DEADMAN engaged — inference frozen"
        : `SENTRA blocked the prompt (${cycle.sentra.signatureMatched ?? "gate"})`,
      provider: "none",
      model: "none",
      provenance: "LIVE",
      nemo: { ok: false, violated: [], rewritten: false, groundTruth: "rule_check" },
      cycle,
      energy: "UNAVAILABLE",
      ledgerCount: ledgerCount(),
      lastHash: ledgerLastHash(),
    });
    return;
  }

  const info = inferenceInfo();
  let raw = localCompose(prompt);
  let provider = "local-compose";
  let model = "software-handles";
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  if (inferenceConfigured()) {
    try {
      const completion = await chatComplete(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        { maxTokens: 280, temperature: 0.2 },
      );
      raw = completion.content || raw;
      provider = info.provider ?? "configured";
      model = info.model ?? "configured";
      if (completion.usage) {
        usage.promptTokens = completion.usage.promptTokens ?? 0;
        usage.completionTokens = completion.usage.completionTokens ?? 0;
        usage.totalTokens = completion.usage.totalTokens ?? 0;
      }
    } catch {
      provider = "local-compose";
      model = "software-handles";
    }
  }

  const gated = gateAnswer(prompt, raw);
  const sealed = await runGovernedCycle(
    { actor: "immune:nemo-seal", intent: "seal nemo-gated answer" },
    {
      ok: gated.verdict.ok,
      violated: gated.verdict.violated.join(",") || null,
      rewritten: gated.verdict.rewritten,
      provider,
    },
  );

  res.json({
    prompt,
    answer: gated.text,
    blocked: !gated.verdict.ok,
    stoppedReason: gated.verdict.ok
      ? gated.verdict.rewritten
        ? "NEMO rewrote the answer to conform (rule_check ground truth)"
        : "NEMO admitted the answer"
      : `NEMO fail-closed: ${gated.verdict.violated.join(", ")}`,
    provider,
    model,
    provenance: "LIVE",
    nemo: gated.verdict,
    cycle: sealed,
    usage,
    energy: "UNAVAILABLE",
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

export default router;
