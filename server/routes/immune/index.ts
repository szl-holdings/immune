import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

const RunImmuneCycleBody = z.object({
  actor: z.string().trim().min(1).max(256),
  intent: z.string().trim().min(1).max(4_096),
}).strict();
import {
  AuthorityError,
  applySignedAction,
  getState,
  publicAuthoritySnapshot,
} from "./state";
import {
  ledgerCount,
  ledgerLastHash,
  ledgerLatest,
  verifyLedger,
  evidenceLatest,
} from "./ledger";
import { getFrameworks, getTransparency, getIncidents, getLeaders, getPulse } from "./intel";
import { CycleReadinessError, runGovernedCycle } from "./cycle";
import { publicKeyInfo } from "./signing";
import agentRouter, { agentStatus } from "./agent";

const router: IRouter = Router();

router.get("/state", (_req: Request, res: Response) => {
  const s = getState();
  res.json({
    ...publicAuthoritySnapshot(s),
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

function applyAction(req: Request, res: Response): void {
  try {
    const s = applySignedAction(req.body);
    res.status(201).json({
      ...publicAuthoritySnapshot(s),
      ledgerCount: ledgerCount(),
      lastHash: ledgerLastHash(),
    });
  } catch (error) {
    const authorityError =
      error instanceof AuthorityError
        ? error
        : new AuthorityError("AUTHORITY_UNAVAILABLE", "signed action authority unavailable", 503);
    const failedState = getState();
    res.status(authorityError.status).json({
      error: authorityError.code,
      detail: authorityError.message,
      state: publicAuthoritySnapshot(failedState),
    });
  }
}

router.post("/state", applyAction);
router.post("/reset", (req: Request, res: Response) => {
  if (req.body?.action?.type !== "RESET") {
    res.status(400).json({ error: "INVALID_ACTION", detail: "reset requires a signed RESET envelope" });
    return;
  }
  applyAction(req, res);
});

router.post("/cycle", async (req: Request, res: Response) => {
  const parsed = RunImmuneCycleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    return;
  }
  let result;
  try {
    result = await runGovernedCycle(parsed.data);
  } catch (error) {
    if (error instanceof CycleReadinessError) {
      res.status(503).json({
        error: "WRITE_NOT_READY",
        blockers: error.blockers,
      });
      return;
    }
    throw error;
  }

  res.json({
    pass: result.pass,
    mode: result.mode,
    deadman: result.deadman,
    sentra: result.sentra,
    huklla: result.huklla,
    receipt: result.receipt,
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

router.get("/ledger/latest", (_req: Request, res: Response) => {
  const entries = ledgerLatest(25);
  res.json({ count: ledgerCount(), entries });
});

router.get("/ledger/verify", (_req: Request, res: Response) => {
  const report = verifyLedger();
  res.json(report);
});

router.get("/evidence/latest", (_req: Request, res: Response) => {
  const entries = evidenceLatest(25);
  res.json({ count: entries.length, entries });
});

router.get("/intel/frameworks", async (_req: Request, res: Response) => {
  const data = await getFrameworks();
  res.json(data);
});

router.get("/intel/transparency", async (_req: Request, res: Response) => {
  const data = await getTransparency();
  res.json(data);
});

router.get("/intel/incidents", async (_req: Request, res: Response) => {
  const data = await getIncidents();
  res.json(data);
});

router.get("/intel/leaders", (_req: Request, res: Response) => {
  res.json(getLeaders());
});

router.get("/intel/pulse", async (_req: Request, res: Response) => {
  const data = await getPulse();
  res.json(data);
});

// The server's Ed25519 public identity for offline signature verification.
router.get("/pubkey", (_req: Request, res: Response) => {
  res.json(publicKeyInfo());
});

// A convenience mirror of the agent status at the top level (the UI can also
// read /agent/status). Kept so /state consumers can discover the live agent.
router.get("/agent-status", (_req: Request, res: Response) => {
  res.json(agentStatus());
});

// The live governed agent — /agent/status and /agent/run.
router.use("/agent", agentRouter);

export default router;
