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
import { sentraInspect } from "./sentra";
import { evaluateTripwires, HUKLLA_REGISTRY } from "./huklla";
import {
  appendReceipt,
  appendEvidence,
  ledgerCount,
  ledgerLastHash,
  ledgerLatest,
  verifyLedger,
  evidenceLatest,
} from "./ledger";
import { canonicalBytes, CanonicalError } from "./canonical";
import { getFrameworks, getTransparency, getIncidents, getLeaders, getPulse } from "./intel";

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
  const s = getState();

  const intentPayload = {
    actor: actor ?? "operator@immune.demo",
    intent: intent ?? "DEMO: read public market snapshot",
  };

  const sentra = sentraInspect(intentPayload, s.mode);

  let receiptOut: any = null;
  let payloadBytes = 0;
  let pass = false;

  if (s.deadman) {
    pass = false;
  } else if (sentra.accepted) {
    const payload: Record<string, unknown> = {
      actor: intentPayload.actor,
      intent: intentPayload.intent,
      mode: s.mode,
      sentra: {
        accepted: true,
        signatureMatched: sentra.signatureMatched ?? "intent.required",
      },
    };
    try {
      payloadBytes = canonicalBytes({ payload }).byteLength;
      const r = await appendReceipt({ payload });
      receiptOut = r;
      pass = true;
    } catch (err) {
      const detail = err instanceof CanonicalError ? err.message : (err as Error).message;
      receiptOut = null;
      pass = false;
      sentra.accepted = false;
      sentra.reason = `canonicalize: ${detail}`;
      sentra.signatureMatched = "guard.canonical";
    }
  }

  const huklla = evaluateTripwires({
    mode: s.mode,
    selectedTripwire: s.tripwire,
    sentraAccepted: sentra.accepted,
    payloadBytes,
    receiptWritten: receiptOut !== null,
  });

  appendEvidence({
    ts: new Date().toISOString(),
    cycleSeq: ledgerCount(),
    fired: huklla,
  });

  res.json({
    pass,
    mode: s.mode,
    deadman: s.deadman,
    sentra,
    huklla,
    receipt: receiptOut,
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

export default router;
