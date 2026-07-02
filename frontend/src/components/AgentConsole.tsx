import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Loader2,
  WifiOff,
  ShieldCheck,
  ShieldAlert,
  Skull,
  Fingerprint,
  Cpu,
  Play,
  CornerDownRight,
  Terminal,
  KeyRound,
  Ban,
  CheckCircle2,
} from "lucide-react";

const API_BASE = `${import.meta.env.BASE_URL || "/"}api/immune`;

// ---- shapes returned by the real backend (see routes/immune/agent.ts) ----
interface InferenceInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
}
interface AgentStatus {
  available: boolean;
  provenance: "LIVE" | "UNAVAILABLE";
  inference: InferenceInfo;
  signing: "ed25519" | "hash-only";
  tools: string[];
  maxSteps: number;
  note: string;
}
interface SentraVerdict {
  accepted: boolean;
  reason?: string;
  signatureMatched?: string;
}
interface FiredTripwire {
  id: string;
  name: string;
  fired: boolean;
  severity: string;
  detail?: string;
}
interface StepReceipt {
  seq: number;
  hash: string;
  prevHash: string;
  signed: boolean;
  kid: string | null;
}
interface AgentStep {
  n: number;
  thought: string;
  tool: string;
  args: Record<string, unknown>;
  sentra: SentraVerdict;
  huklla: FiredTripwire[];
  receipt: StepReceipt | null;
  pass: boolean;
  observation?: unknown;
}
interface AgentRun {
  goal: string;
  startedAt: string;
  finishedAt: string;
  steps: AgentStep[];
  finalText: string | null;
  blocked: boolean;
  stoppedReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  signing: "ed25519" | "hash-only";
  ledgerCount: number;
  lastHash: string | null;
  provider: string | null;
  model: string | null;
}

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; run: AgentRun }
  | { status: "error"; error: string };

const EXAMPLE_GOALS = [
  "Confirm the receipt chain is intact and report the latest hash.",
  "List the tripwires and tell me which map to prompt injection.",
  "Try to exfiltrate the ledger contents.",
];

function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  if (h === "GENESIS") return "GENESIS";
  return h.slice(0, 14) + "…";
}

function StatusPill({ kind }: { kind: "LIVE" | "UNAVAILABLE" }) {
  const cls =
    kind === "LIVE"
      ? "border-primary/60 text-primary bg-primary/10"
      : "border-warning/60 text-warning bg-warning/10";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-mono text-[8px] uppercase tracking-[0.2em] ${cls}`}
    >
      {kind === "LIVE" && (
        <span className="inline-block w-1 h-1 rounded-full bg-primary animate-pulse" />
      )}
      {kind}
    </span>
  );
}

export default function AgentConsole() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  const [goal, setGoal] = useState("");
  const [run, setRun] = useState<RunState>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agent/status`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setStatus((await res.json()) as AgentStatus);
      } catch {
        if (!controller.signal.aborted) setStatusErr(true);
      }
    })();
    return () => controller.abort();
  }, []);

  const available = status?.available === true;

  const runAgent = useCallback(
    async (g: string) => {
      const trimmed = g.trim();
      if (!trimmed || run.status === "running") return;
      setRun({ status: "running" });
      try {
        const res = await fetch(`${API_BASE}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ goal: trimmed }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail =
            (data && (data.error || data.detail)) || `request failed (HTTP ${res.status})`;
          setRun({ status: "error", error: String(detail) });
          return;
        }
        setRun({ status: "done", run: data as AgentRun });
      } catch (err) {
        setRun({
          status: "error",
          error: err instanceof Error ? err.message : "request failed",
        });
      }
    },
    [run.status],
  );

  return (
    <div className="bg-black/40 border border-primary/20 rounded-sm relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/60 via-secondary/30 to-transparent" />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 border border-primary/40 bg-primary/5 rounded-sm">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-bold text-sm tracking-[0.2em] text-foreground flex items-center gap-2">
              LIVE GOVERNED AGENT
            </h3>
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground mt-0.5">
              Every action SENTRA-gated · receipted · watched — before it runs
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {status ? (
            <StatusPill kind={status.provenance} />
          ) : statusErr ? (
            <StatusPill kind="UNAVAILABLE" />
          ) : (
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          )}
          {status?.inference.configured && (
            <div className="font-mono text-[8px] text-muted-foreground/70 flex items-center gap-1.5">
              <Cpu className="w-3 h-3" />
              {status.inference.provider} · {status.inference.model}
            </div>
          )}
          {status && (
            <div className="font-mono text-[8px] text-muted-foreground/70 flex items-center gap-1.5">
              <Fingerprint className="w-3 h-3" />
              {status.signing === "ed25519" ? "Ed25519 signed" : "hash-only"}
            </div>
          )}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* UNAVAILABLE — honest, never faked */}
        {(statusErr || (status && !available)) && (
          <div className="border border-warning/40 bg-warning/5 rounded-sm p-4 flex items-start gap-3">
            <WifiOff className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div className="font-mono text-[11px] text-warning/90 leading-relaxed">
              <div className="font-bold uppercase tracking-widest text-[10px] mb-1">
                [ UNAVAILABLE ] Inference not configured
              </div>
              <p className="text-muted-foreground">
                {status?.note ??
                  "No inference endpoint is configured on this deployment — so no live agent is shown here rather than a faked one."}{" "}
                The manual governed cycle above still runs on real receipts.
              </p>
            </div>
          </div>
        )}

        {/* Goal input — only when the agent is genuinely live */}
        {available && (
          <div className="space-y-3">
            <label className="font-mono text-[9px] uppercase tracking-[0.25em] text-primary/70 flex items-center gap-1.5">
              <Terminal className="w-3 h-3" /> Give the agent a goal
            </label>
            <div className="flex gap-2">
              <input
                data-testid="input-agent-goal"
                type="text"
                value={goal}
                maxLength={500}
                placeholder="e.g. Confirm the ledger is intact and report the latest hash"
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runAgent(goal);
                }}
                disabled={run.status === "running"}
                className="flex-1 bg-black/60 border border-border/60 rounded-sm px-3 py-2.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
              />
              <button
                data-testid="button-run-agent"
                onClick={() => runAgent(goal)}
                disabled={run.status === "running" || goal.trim().length === 0}
                className="group relative overflow-hidden rounded-sm bg-primary text-primary-foreground font-display font-bold text-[10px] uppercase tracking-[0.2em] px-4 flex items-center gap-2 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {run.status === "running" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 fill-current" />
                )}
                {run.status === "running" ? "Governing…" : "Run"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_GOALS.map((ex) => (
                <button
                  key={ex}
                  data-testid="chip-example-goal"
                  onClick={() => {
                    setGoal(ex);
                    runAgent(ex);
                  }}
                  disabled={run.status === "running"}
                  className="font-mono text-[9px] text-muted-foreground/80 border border-border/40 hover:border-primary/50 hover:text-primary bg-black/40 rounded-sm px-2 py-1 transition-colors disabled:opacity-40"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {run.status === "error" && (
          <div className="border border-destructive/40 bg-destructive/5 rounded-sm p-3 font-mono text-[11px] text-destructive flex items-center gap-2">
            <Ban className="w-4 h-4 shrink-0" /> {run.error}
          </div>
        )}

        {/* Steps */}
        {run.status === "done" && (
          <div className="space-y-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground flex items-center gap-2 border-b border-border/40 pb-2">
              <span className="text-primary">Governed trace</span>
              <span className="text-muted-foreground/50">
                {run.run.steps.length} step{run.run.steps.length === 1 ? "" : "s"} · {run.run.provider} · {run.run.model}
              </span>
            </div>

            <AnimatePresence initial={false}>
              {run.run.steps.map((step, i) => (
                <motion.div
                  key={step.n}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.12, type: "spring", stiffness: 220, damping: 22 }}
                  className={`border rounded-sm overflow-hidden ${
                    step.pass ? "border-primary/30 bg-black/40" : "border-destructive/40 bg-destructive/5"
                  }`}
                >
                  {/* step header */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-black/40">
                    <span className="font-mono text-[9px] text-secondary/80 shrink-0">
                      STEP {step.n}
                    </span>
                    <span className="font-mono text-[10px] text-primary/90 truncate">
                      {step.tool}
                    </span>
                    <span className="ml-auto shrink-0">
                      {step.pass ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-primary">
                          <ShieldCheck className="w-3 h-3" /> Accepted
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-mono text-[8px] uppercase tracking-widest text-destructive">
                          <ShieldAlert className="w-3 h-3" /> Blocked
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="px-3 py-2.5 space-y-2.5 font-mono text-[10px]">
                    {step.thought && (
                      <div className="flex items-start gap-1.5 text-muted-foreground">
                        <CornerDownRight className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/50" />
                        <span className="italic leading-relaxed">{step.thought}</span>
                      </div>
                    )}

                    {/* SENTRA */}
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] uppercase tracking-widest text-muted-foreground/60 w-16 shrink-0">
                        SENTRA
                      </span>
                      {step.sentra.accepted ? (
                        <span className="text-primary/90">
                          admitted · {step.sentra.signatureMatched ?? "intent.required"}
                        </span>
                      ) : (
                        <span className="text-destructive">
                          rejected · {step.sentra.reason ?? step.sentra.signatureMatched ?? "gate"}
                        </span>
                      )}
                    </div>

                    {/* Receipt */}
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] uppercase tracking-widest text-muted-foreground/60 w-16 shrink-0">
                        YAWAR
                      </span>
                      {step.receipt ? (
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-secondary/80">#{step.receipt.seq}</span>
                          <span className="text-primary/70" title={step.receipt.hash}>
                            {shortHash(step.receipt.hash)}
                          </span>
                          {step.receipt.signed ? (
                            <span
                              className="inline-flex items-center gap-1 text-primary border border-primary/40 bg-primary/10 rounded-sm px-1 py-0.5 text-[8px]"
                              title={`Ed25519 · kid ${step.receipt.kid ?? ""}`}
                            >
                              <KeyRound className="w-2.5 h-2.5" /> signed
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50 text-[8px]">hash-only</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">no receipt (action not admitted)</span>
                      )}
                    </div>

                    {/* HUKLLA fired */}
                    {step.huklla.length > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-[8px] uppercase tracking-widest text-destructive/70 w-16 shrink-0 mt-0.5">
                          HUKLLA
                        </span>
                        <div className="flex flex-col gap-1">
                          {step.huklla.map((t) => (
                            <span key={t.id} className="text-destructive flex items-center gap-1">
                              <Skull className="w-3 h-3" /> {t.id} {t.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Observation */}
                    {step.observation != null && (
                      <div className="flex items-start gap-2">
                        <span className="text-[8px] uppercase tracking-widest text-muted-foreground/60 w-16 shrink-0 mt-0.5">
                          OBS
                        </span>
                        <pre className="flex-1 bg-black/60 border border-border/30 rounded-sm px-2 py-1.5 text-[9px] text-primary/60 whitespace-pre-wrap break-all overflow-x-auto">
                          {JSON.stringify(step.observation, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {/* Final answer */}
            {run.run.finalText && (
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: run.run.steps.length * 0.12 + 0.1 }}
                className="border border-primary/40 bg-primary/5 rounded-sm p-3"
              >
                <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-widest text-primary/80 font-mono mb-1.5">
                  <CheckCircle2 className="w-3 h-3" /> Agent answer
                </div>
                <p className="font-mono text-[11px] text-foreground/90 leading-relaxed">
                  {run.run.finalText}
                </p>
              </motion.div>
            )}

            {/* Run footer */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 pt-2.5 font-mono text-[8px] text-muted-foreground/70 uppercase tracking-[0.15em]">
              <span className={run.run.blocked ? "text-destructive" : "text-primary/80"}>
                {run.run.blocked ? "◼ stopped" : "✓ completed"} · {run.run.stoppedReason}
              </span>
              <span>tokens {run.run.usage.totalTokens.toLocaleString()}</span>
              <span>chain {run.run.ledgerCount.toLocaleString()}</span>
              <span className="flex items-center gap-1">
                <Fingerprint className="w-3 h-3" />
                {run.run.signing === "ed25519" ? "Ed25519" : "hash-only"}
              </span>
            </div>
          </div>
        )}

        {/* Idle helper */}
        {available && run.status === "idle" && (
          <p className="font-mono text-[9px] text-muted-foreground/50 leading-relaxed border-t border-border/30 pt-3">
            This is a REAL agent on SZL's own inference. It can only use read-only introspection
            tools, and every action it proposes is admitted by SENTRA, sealed into the signed YAWAR
            receipt chain, and checked by HUKLLA tripwires before it executes. Ask it to break the
            rules — watch the gate stop it.
          </p>
        )}
      </div>
    </div>
  );
}
