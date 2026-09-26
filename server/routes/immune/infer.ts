import type { Request, Response, IRouter } from "express";
import { Router } from "express";
import { z } from "zod";
import { runGovernedCycle, CycleReadinessError } from "./cycle";
import { governedAnswer } from "./infer-answer";
import { ensureNemoTrained, nemoStatus } from "./nemo";
import { ledgerCount, ledgerLastHash } from "./ledger";

const InferBody = z.object({
  prompt: z.string().trim().min(4).max(500),
});

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

  const answer = await governedAnswer(prompt, runGovernedCycle);

  res.json({
    prompt,
    answer: answer.text,
    blocked: !answer.verdict.ok,
    stoppedReason: answer.verdict.ok
      ? answer.verdict.rewritten
        ? "NEMO rewrote the answer to conform (rule_check ground truth)"
        : "NEMO admitted the answer"
      : `NEMO fail-closed: ${answer.verdict.violated.join(", ")}`,
    provider: answer.provider,
    model: answer.model,
    provenance: "LIVE",
    nemo: answer.verdict,
    cycle: answer.sealed,
    usage: answer.usage,
    energy: "UNAVAILABLE",
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

export default router;
