import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { readinessStatus } from "../../readiness";
import { runGovernedCycle, CycleReadinessError } from "./cycle";
import { ledgerCount, ledgerLatest, type Receipt } from "./ledger";
import {
  NEXUS_MODES,
  NEXUS_PROGRAMS,
  NEXUS_RUN_SCHEMA,
  NEXUS_SOURCE_REVISION,
  NexusValidationError,
  nexusInputHash,
  nexusStatus,
  runNexus,
  verifyNexusRun,
  type NexusRunInput,
} from "./nexus-engine";
import { sentraInspect } from "./sentra";
import { authoritativeTripwireState, getState } from "./state";

const router: IRouter = Router();

const FiniteNumber = z.number().finite();
const NexusStateSchema = z
  .object({
    x: FiniteNumber,
    y: FiniteNumber,
    z: FiniteNumber,
    t: FiniteNumber.min(0).max(1_000_000),
    bank: z
      .array(FiniteNumber)
      .min(15)
      .max(20)
      .refine((value) => value.length === 15 || value.length === 20, {
        message: "bank must contain exactly 15 or 20 values",
      })
      .optional(),
  })
  .strict();

const NexusInputSchema = z
  .object({
    program: z.enum(NEXUS_PROGRAMS),
    mode: z.enum(NEXUS_MODES).default("OP"),
    steps: z.number().int().min(0).max(2_400).default(320),
    dt: FiniteNumber.min(0.0004).max(0.08).default(0.01),
    chaos: FiniteNumber.min(0).max(1).default(0.45),
    drive: FiniteNumber.min(0).max(1).default(0.7),
    seed: FiniteNumber.min(0).max(1).default(0.2),
    repeatEvery: z.number().int().min(1).max(512).default(64),
    state: NexusStateSchema.optional(),
    axes: z.array(FiniteNumber.min(0).max(1)).min(1).max(64).optional(),
  })
  .strict();

const NexusRunBody = NexusInputSchema.extend({
  actor: z.string().trim().min(1).max(256),
  requestId: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

const NexusVerifyBody = NexusInputSchema.extend({
  expectedOutputHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();

type NexusReceiptPayload = {
  schema: "szl.immune-nexus-receipt/v1";
  requestId: string;
  inputHash: string;
  outputHash: string;
  sourceRevision: typeof NEXUS_SOURCE_REVISION;
  execution: {
    program: string;
    mode: string;
    stepsExecuted: number;
    repeatCount: number;
    externalCalls: 0;
    externalEffectors: false;
    truth: "MEASURED_SOFTWARE_SIMULATION";
  };
  invariantsHold: boolean;
  energy: "UNAVAILABLE";
  uniqueness: "Conjecture 1 OPEN";
};

const minuteBudget = new Map<string, { startedAt: number; count: number }>();
const nexusRequestLocks = new Map<string, Promise<void>>();
const RUNS_PER_MINUTE = 12;

async function withNexusRequestLock<T>(requestId: string, action: () => Promise<T>): Promise<T> {
  const previous = nexusRequestLocks.get(requestId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  nexusRequestLocks.set(requestId, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (nexusRequestLocks.get(requestId) === tail) {
      nexusRequestLocks.delete(requestId);
    }
  }
}

function consumeBudget(req: Request, res: Response): boolean {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = minuteBudget.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    minuteBudget.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= RUNS_PER_MINUTE) {
    const retryAfter = Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1_000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "NEXUS_RATE_LIMIT",
      detail: `bounded simulation budget is ${RUNS_PER_MINUTE} requests per minute per client`,
      retryAfterSeconds: retryAfter,
    });
    return false;
  }
  current.count += 1;
  return true;
}

function toInput(parsed: z.infer<typeof NexusInputSchema>): NexusRunInput {
  return {
    program: parsed.program,
    mode: parsed.mode,
    steps: parsed.steps,
    dt: parsed.dt,
    chaos: parsed.chaos,
    drive: parsed.drive,
    seed: parsed.seed,
    repeatEvery: parsed.repeatEvery,
    ...(parsed.state ? { state: parsed.state } : {}),
    ...(parsed.axes ? { axes: parsed.axes } : {}),
  };
}

function nexusPayload(receipt: Receipt): NexusReceiptPayload | null {
  const agent = receipt.payload.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return null;
  const nexus = (agent as Record<string, unknown>).nexus;
  if (!nexus || typeof nexus !== "object" || Array.isArray(nexus)) return null;
  return nexus as NexusReceiptPayload;
}

function findNexusReceipt(requestId: string): {
  receipt: Receipt;
  nexus: NexusReceiptPayload;
} | null {
  for (const receipt of ledgerLatest(ledgerCount())) {
    const nexus = nexusPayload(receipt);
    if (nexus?.requestId === requestId) return { receipt, nexus };
  }
  return null;
}

function compactReceiptPayload(
  requestId: string,
  result: ReturnType<typeof runNexus>,
): NexusReceiptPayload {
  return {
    schema: "szl.immune-nexus-receipt/v1",
    requestId,
    inputHash: result.inputHash,
    outputHash: result.outputHash,
    sourceRevision: NEXUS_SOURCE_REVISION,
    execution: {
      program: result.execution.program,
      mode: result.execution.mode,
      stepsExecuted: result.execution.stepsExecuted,
      repeatCount: result.execution.repeatCount,
      externalCalls: 0,
      externalEffectors: false,
      truth: "MEASURED_SOFTWARE_SIMULATION",
    },
    invariantsHold: result.invariants.allHold,
    energy: "UNAVAILABLE",
    uniqueness: "Conjecture 1 OPEN",
  };
}

router.get("/status", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ...nexusStatus(),
    immuneReadiness: readinessStatus(),
  });
});

router.get("/catalog", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    schema: "szl.immune-nexus-catalog/v1",
    sourceRevision: NEXUS_SOURCE_REVISION,
    programs: [
      { id: "lorenz", label: "LRNZ", job: "chaotic attractor stress surface" },
      { id: "harmonic", label: "HARM", job: "bounded oscillator and sign-change witness" },
      { id: "vanderpol", label: "VDP", job: "nonlinear self-excited oscillator" },
      { id: "duffing", label: "DFFG", job: "forced nonlinear counterfactual" },
      { id: "lotka", label: "LTKA", job: "coupled population dynamics" },
      { id: "nemo", label: "NEMO", job: "five-organ AdEx software simulation with WILLAY optical field" },
    ],
    modes: [
      { id: "IC", job: "return a deterministic initial condition" },
      { id: "OP", job: "integrate the selected program" },
      { id: "HALT", job: "freeze and return the supplied state" },
      { id: "REP", job: "integrate with bounded deterministic reseeding" },
    ],
  });
});

router.get("/receipts/:requestId", (req: Request, res: Response) => {
  const requestId = String(req.params.requestId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)) {
    res.status(400).json({ error: "INVALID_REQUEST_ID" });
    return;
  }
  const found = findNexusReceipt(requestId);
  if (!found) {
    res.status(404).json({ error: "NEXUS_RECEIPT_NOT_FOUND", requestId });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    schema: "szl.immune-nexus-receipt-read/v1",
    requestId,
    nexus: found.nexus,
    receipt: found.receipt,
  });
});

router.post("/verify", (req: Request, res: Response) => {
  if (!consumeBudget(req, res)) return;
  const parsed = NexusVerifyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "INVALID_NEXUS_VERIFICATION",
      detail: parsed.error.flatten(),
    });
    return;
  }
  try {
    const input = toInput(parsed.data);
    const proof = verifyNexusRun(input, parsed.data.expectedOutputHash);
    res.setHeader("Cache-Control", "no-store");
    res.status(proof.verified ? 200 : 409).json(proof);
  } catch (error) {
    if (error instanceof NexusValidationError) {
      res.status(400).json({ error: error.code, detail: error.message });
      return;
    }
    throw error;
  }
});

router.post("/run", async (req: Request, res: Response) => {
  if (!consumeBudget(req, res)) return;
  const parsed = NexusRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "INVALID_NEXUS_RUN",
      detail: parsed.error.flatten(),
    });
    return;
  }

  const input = toInput(parsed.data);
  if (input.program === "nemo" && input.steps > 400) {
    res.status(400).json({
      error: "OUT_OF_RANGE",
      detail: "NEMO steps are capped at 400 per request",
    });
    return;
  }

  const readiness = readinessStatus();
  if (!readiness.write_ready) {
    res.status(503).json({
      error: "WRITE_NOT_READY",
      blockers: readiness.blockers,
      computationPerformed: false,
    });
    return;
  }

  const intent = `nexus.simulate:${input.program}:${input.mode}`;
  const authority = authoritativeTripwireState(getState());
  const preflight = sentraInspect(
    {
      actor: parsed.data.actor,
      intent,
      nexus: {
        requestId: parsed.data.requestId,
        program: input.program,
        mode: input.mode,
        steps: input.steps,
      },
    },
    authority.mode,
  );
  if (authority.deadman || !preflight.accepted) {
    res.status(409).json({
      error: authority.deadman ? "DEADMAN_ACTIVE" : "SENTRA_REJECTED",
      sentra: preflight,
      computationPerformed: false,
    });
    return;
  }

  const inputHash = nexusInputHash(input);
  try {
    await withNexusRequestLock(parsed.data.requestId, async () => {
      const existing = findNexusReceipt(parsed.data.requestId);
      const storedActor = existing ? String(existing.receipt.payload.actor ?? "") : "";
      if (existing && (storedActor !== parsed.data.actor || existing.nexus.inputHash !== inputHash)) {
        res.status(409).json({
          error: "NEXUS_REQUEST_ID_COLLISION",
          requestId: parsed.data.requestId,
          storedInputHash: existing.nexus.inputHash,
          presentedInputHash: inputHash,
          computationPerformed: false,
        });
        return;
      }

      const result = runNexus(input);
      if (!result.invariants.allHold) {
        res.status(500).json({
          error: "NEXUS_INVARIANT_FAILURE",
          result,
        });
        return;
      }

      if (existing) {
        if (existing.nexus.outputHash !== result.outputHash) {
          res.status(500).json({
            error: "NEXUS_DETERMINISM_DIVERGENCE",
            requestId: parsed.data.requestId,
            storedOutputHash: existing.nexus.outputHash,
            observedOutputHash: result.outputHash,
          });
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.json({
          schema: NEXUS_RUN_SCHEMA,
          replayed: true,
          requestId: parsed.data.requestId,
          result,
          governed: {
            pass: true,
            receipt: existing.receipt,
            sentra: preflight,
          },
        });
        return;
      }

      const receiptPayload = compactReceiptPayload(parsed.data.requestId, result);
      const governed = await runGovernedCycle(
        { actor: parsed.data.actor, intent },
        { nexus: receiptPayload },
      );
      if (!governed.pass || !governed.receipt) {
        res.status(409).json({
          error: "NEXUS_GOVERNANCE_REJECTED",
          computationPerformed: true,
          externalEffectPerformed: false,
          result,
          governed,
        });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({
        schema: NEXUS_RUN_SCHEMA,
        replayed: false,
        requestId: parsed.data.requestId,
        result,
        governed,
      });
    });
  } catch (error) {
    if (error instanceof CycleReadinessError) {
      res.status(503).json({
        error: "WRITE_NOT_READY",
        blockers: error.blockers,
        computationPerformed: true,
        externalEffectPerformed: false,
      });
      return;
    }
    if (error instanceof NexusValidationError) {
      res.status(400).json({ error: error.code, detail: error.message });
      return;
    }
    throw error;
  }
});

export default router;
