import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

// Local mirrors of the api-zod request schemas (the generated api-zod dist on
// disk predates these immune endpoints). Kept in lockstep with
// lib/api-zod/src/generated/api.ts.
const SetImmuneStateBody = z.object({
  mode: z.enum(["PASS", "SENTRA_REJECT", "DEADMAN"]),
  tripwire: z
    .enum(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"])
    .optional(),
});

const RunImmuneCycleBody = z.object({
  actor: z.string().optional(),
  intent: z.string().optional(),
});
import { getState, setState, clearDeadman } from "./state";
import { HUKLLA_REGISTRY } from "./huklla";
import {
  ledgerCount,
  ledgerLastHash,
  ledgerLatest,
  verifyLedger,
  evidenceLatest,
} from "./ledger";
import { getFrameworks, getTransparency, getIncidents, getLeaders, getPulse } from "./intel";
import { runGovernedCycle } from "./cycle";
import { publicKeyInfo } from "./signing";
import agentRouter, { agentStatus } from "./agent";

const router: IRouter = Router();

router.get("/state", (_req: Request, res: Response) => {
  const s = getState();
  res.json({
    mode: s.mode,
    tripwire: s.tripwire,
    deadman: s.deadman,
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

router.post("/state", (req: Request, res: Response) => {
  const parsed = SetImmuneStateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    return;
  }
  const { mode, tripwire } = parsed.data;
  if (mode === "DEADMAN" && !tripwire) {
    res.status(400).json({ error: "DEADMAN requires a tripwire id (T01–T10)" });
    return;
  }
  if (tripwire && !HUKLLA_REGISTRY.find((t) => t.id === tripwire)) {
    res.status(400).json({ error: `unknown tripwire: ${tripwire}` });
    return;
  }
  const s = setState(mode, tripwire ?? null);
  res.json({
    mode: s.mode,
    tripwire: s.tripwire,
    deadman: s.deadman,
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

router.post("/reset", (_req: Request, res: Response) => {
  const s = clearDeadman();
  res.json({
    mode: s.mode,
    tripwire: s.tripwire,
    deadman: s.deadman,
    ledgerCount: ledgerCount(),
    lastHash: ledgerLastHash(),
  });
});

router.post("/cycle", async (req: Request, res: Response) => {
  const parsed = RunImmuneCycleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
    return;
  }
  const { actor, intent } = parsed.data;

  const intentPayload = {
    actor: actor ?? "operator@immune.demo",
    intent: intent ?? "DEMO: read public market snapshot",
  };

  const result = await runGovernedCycle(intentPayload);

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
