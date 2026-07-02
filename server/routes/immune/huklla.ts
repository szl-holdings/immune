export type HukllaSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface HukllaTripwire {
  id: string;
  name: string;
  severity: HukllaSeverity;
  description: string;
}

export const HUKLLA_REGISTRY: HukllaTripwire[] = [
  { id: "T01", name: "intent.unsigned",        severity: "high",     description: "Intent missing required signature fields" },
  { id: "T02", name: "actor.unknown",          severity: "medium",   description: "Actor is not in the allow-list" },
  { id: "T03", name: "rate.exceeded",          severity: "medium",   description: "Cycle rate exceeded operator budget" },
  { id: "T04", name: "payload.oversize",       severity: "high",     description: "Canonical payload exceeded 1MB" },
  { id: "T05", name: "egress.unauthorized",    severity: "critical", description: "Outbound egress to non-allowlisted host" },
  { id: "T06", name: "ledger.divergence",      severity: "critical", description: "Ledger hash chain disagrees with recomputed chain" },
  { id: "T07", name: "deadman.engaged",        severity: "critical", description: "DEADMAN freeze is active — refuse all writes" },
  { id: "T08", name: "sentra.bypass",          severity: "critical", description: "Receipt produced without SENTRA acceptance" },
  { id: "T09", name: "clock.skew",             severity: "low",      description: "System clock skew vs NTP exceeds threshold" },
  { id: "T10", name: "evidence.gap",           severity: "high",     description: "HUKLLA evidence chain has a gap vs cycle counter" },
];

export interface HukllaFiredTripwire {
  id: string;
  name: string;
  fired: boolean;
  severity: HukllaSeverity;
  detail?: string;
}

export interface HukllaContext {
  mode: "PASS" | "SENTRA_REJECT" | "DEADMAN";
  selectedTripwire: string | null;
  sentraAccepted: boolean;
  payloadBytes: number;
  receiptWritten: boolean;
}

export function evaluateTripwires(ctx: HukllaContext): HukllaFiredTripwire[] {
  const out: HukllaFiredTripwire[] = HUKLLA_REGISTRY.map((t) => ({
    id: t.id,
    name: t.name,
    severity: t.severity,
    fired: false,
  }));
  const fire = (id: string, detail: string) => {
    const row = out.find((r) => r.id === id);
    if (row) {
      row.fired = true;
      row.detail = detail;
    }
  };

  if (ctx.mode === "DEADMAN") {
    fire("T07", "operator engaged DEADMAN freeze");
    if (ctx.selectedTripwire && ctx.selectedTripwire !== "T07") {
      const sel = HUKLLA_REGISTRY.find((t) => t.id === ctx.selectedTripwire);
      if (sel) fire(sel.id, `operator-staged tripwire: ${sel.description}`);
    }
  }
  if (ctx.mode === "SENTRA_REJECT" && !ctx.sentraAccepted) {
    fire("T01", "SENTRA rejected the intent — no signature match");
  }
  if (ctx.payloadBytes > 1_048_576) fire("T04", `payload ${ctx.payloadBytes} bytes`);
  if (!ctx.sentraAccepted && ctx.receiptWritten) fire("T08", "receipt persisted without SENTRA acceptance");
  return out;
}
