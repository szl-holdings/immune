import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldAlert, Skull, Activity, Play, FileSignature, AlertTriangle } from "lucide-react";
import {
  useSubmitImmuneAction,
  useRunImmuneCycle,
  getGetImmuneStateQueryKey,
  getGetImmuneLedgerLatestQueryKey,
  getVerifyImmuneLedgerQueryKey,
  getGetImmuneEvidenceLatestQueryKey,
  type AuthoritativeTripwireState,
  type ImmuneMode,
  type SignedActionEnvelope,
} from "@/lib/immune-api";

const MODES: { id: ImmuneMode; label: string; sub: string; icon: React.FC<any> }[] = [
  { id: "PASS", label: "PASS", sub: "Clean payload · Signature match", icon: ShieldCheck },
  { id: "SENTRA_REJECT", label: "SENTRA REJECT", sub: "Force rejection at gate", icon: ShieldAlert },
  { id: "DEADMAN", label: "DEADMAN", sub: "Freeze ledger · Total lockdown", icon: Skull },
];

const TRIPWIRES = [
  { id: "T01", name: "intent.unsigned" },
  { id: "T02", name: "actor.unknown" },
  { id: "T03", name: "rate.exceeded" },
  { id: "T04", name: "payload.oversize" },
  { id: "T05", name: "egress.unauthorized" },
  { id: "T06", name: "ledger.divergence" },
  { id: "T07", name: "deadman.engaged" },
  { id: "T08", name: "sentra.bypass" },
  { id: "T09", name: "clock.skew" },
  { id: "T10", name: "evidence.gap" },
];

export function ControlsPanel({ authority }: { authority: AuthoritativeTripwireState }) {
  const qc = useQueryClient();
  const submitAction = useSubmitImmuneAction();
  const runCycle = useRunImmuneCycle();

  const currentMode: ImmuneMode = authority.mode;
  const currentTripwire = authority.tripwire;
  const evidenceState = authority.evidenceState;
  const [envelopeDraft, setEnvelopeDraft] = useState("");
  const [envelopeError, setEnvelopeError] = useState<string | null>(null);
  const [verifierBusy, setVerifierBusy] = useState(false);
  const [cycleActor, setCycleActor] = useState("");
  const [cycleIntent, setCycleIntent] = useState("");

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: getGetImmuneStateQueryKey() });
    qc.invalidateQueries({ queryKey: getGetImmuneLedgerLatestQueryKey() });
    qc.invalidateQueries({ queryKey: getVerifyImmuneLedgerQueryKey() });
    qc.invalidateQueries({ queryKey: getGetImmuneEvidenceLatestQueryKey() });
  };

  const handleSignedAction = () => {
    setEnvelopeError(null);
    let envelope: SignedActionEnvelope;
    try {
      envelope = JSON.parse(envelopeDraft) as SignedActionEnvelope;
    } catch {
      setEnvelopeError("Envelope must be valid JSON.");
      return;
    }
    submitAction.mutate(
      { data: envelope },
      {
        onSuccess: () => {
          setEnvelopeDraft("");
          invalidateAll();
        },
        onError: (error) => setEnvelopeError(error.message),
      },
    );
  };

  const handleRun = () => {
    const actor = cycleActor.trim();
    const intent = cycleIntent.trim();
    if (!actor || !intent) return;
    runCycle.mutate(
      { data: { actor, intent } },
      {
        onSuccess: () => {
          setCycleIntent("");
          invalidateAll();
        },
      },
    );
  };

  const handleVerify = async () => {
    setVerifierBusy(true);
    try {
      await qc.refetchQueries({ queryKey: getVerifyImmuneLedgerQueryKey() });
    } finally {
      setVerifierBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-8 z-10 relative">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              evidenceState === "VERIFIED" ? "bg-primary animate-pulse" : "bg-warning"
            }`}
          />
          <h2 className="text-primary text-[10px] font-mono uppercase tracking-[0.3em]">
            Authoritative State · {evidenceState}
          </h2>
        </div>
        
        <div className="flex flex-col gap-2">
          {MODES.map((m) => {
            const active = currentMode === m.id;
            const isDanger = m.id !== "PASS";
            const Icon = m.icon;
            
            return (
              <button
                key={m.id}
                data-testid={`button-mode-${m.id}`}
                disabled
                aria-pressed={active}
                className={`
                  relative overflow-hidden text-left rounded-sm border p-3 transition-all duration-300 flex items-center gap-3
                  ${active
                    ? isDanger
                      ? m.id === "DEADMAN" 
                        ? "border-destructive bg-destructive/20 text-destructive shadow-[0_0_15px_rgba(255,0,0,0.3)]"
                        : "border-warning bg-warning/20 text-warning shadow-[0_0_15px_rgba(255,170,0,0.3)]"
                      : "border-primary bg-primary/20 text-primary shadow-[0_0_15px_rgba(0,255,255,0.2)]"
                    : "border-border bg-black/40 text-muted-foreground"
                  }
                `}
              >
                {active && (
                  <motion.div 
                    layoutId="activeMode"
                    className={`absolute inset-0 opacity-20 ${isDanger ? (m.id === 'DEADMAN' ? 'bg-destructive' : 'bg-warning') : 'bg-primary'}`}
                  />
                )}
                <Icon className={`w-5 h-5 ${active ? '' : 'opacity-50'}`} />
                <div className="relative z-10">
                  <div className="font-display font-bold text-xs tracking-wider">{m.label}</div>
                  <div className={`text-[9px] mt-1 font-mono ${active ? 'opacity-80' : 'opacity-50'}`}>{m.sub}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {currentMode === "DEADMAN" && (
        <motion.div 
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="flex flex-col gap-2"
        >
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-3 h-3" />
            <h2 className="text-[10px] font-mono uppercase tracking-[0.3em]">Select Tripwire</h2>
          </div>
          <div
            data-testid="active-tripwire"
            className="w-full bg-black/60 border border-destructive/50 rounded-sm px-3 py-2.5 text-xs font-mono text-destructive"
          >
            {currentTripwire} // {TRIPWIRES.find((item) => item.id === currentTripwire)?.name ?? "unknown"}
          </div>
        </motion.div>
      )}

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded-sm border border-primary/30 bg-black/50 p-3">
          <label
            htmlFor="signed-action-envelope"
            className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-[0.2em] text-primary"
          >
            <FileSignature className="h-3.5 w-3.5" /> Signed advisory envelope
          </label>
          <textarea
            id="signed-action-envelope"
            data-testid="input-signed-action-envelope"
            value={envelopeDraft}
            onChange={(event) => setEnvelopeDraft(event.target.value)}
            placeholder='{"version":"immune.action.v1", ...}'
            className="min-h-20 w-full resize-y rounded-sm border border-border/50 bg-black/70 p-2 font-mono text-[9px] text-foreground focus:border-primary focus:outline-none"
          />
          <button
            data-testid="button-submit-signed-action"
            onClick={handleSignedAction}
            disabled={submitAction.isPending || envelopeDraft.trim().length === 0}
            className="rounded-sm border border-primary/40 bg-primary/10 py-2 font-mono text-[9px] uppercase tracking-widest text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitAction.isPending ? "Verifying + persisting…" : "Apply verified advisory"}
          </button>
          {(envelopeError || evidenceState !== "VERIFIED") && (
            <p
              className="font-mono text-[8px] leading-relaxed text-warning"
              data-testid="action-authority-status"
              role="status"
              aria-live="polite"
            >
              {envelopeError ?? authority.reason}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-sm border border-warning/30 bg-warning/5 p-3">
          <p id="cycle-write-warning" className="font-mono text-[9px] leading-relaxed text-warning">
            Accepted input writes a real governed-cycle receipt. Enter the actual actor and intent; no demo payload is supplied.
          </p>
          <label htmlFor="cycle-actor" className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
            Actor
          </label>
          <input
            id="cycle-actor"
            value={cycleActor}
            onChange={(event) => setCycleActor(event.target.value)}
            autoComplete="off"
            className="rounded-sm border border-border/50 bg-black/70 px-3 py-2 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
          />
          <label htmlFor="cycle-intent" className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
            Intent
          </label>
          <textarea
            id="cycle-intent"
            value={cycleIntent}
            onChange={(event) => setCycleIntent(event.target.value)}
            className="min-h-20 resize-y rounded-sm border border-border/50 bg-black/70 p-3 font-mono text-[10px] text-foreground focus:border-primary focus:outline-none"
          />
        </div>

        <button
          data-testid="button-run-cycle"
          onClick={handleRun}
          disabled={
            runCycle.isPending ||
            evidenceState !== "VERIFIED" ||
            cycleActor.trim().length === 0 ||
            cycleIntent.trim().length === 0
          }
          aria-describedby="cycle-write-warning"
          className={`
            group relative w-full overflow-hidden rounded-sm font-display font-bold text-xs uppercase tracking-[0.2em] py-4 transition-all
            ${currentMode === "DEADMAN" 
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" 
              : currentMode === "SENTRA_REJECT"
                ? "bg-warning text-warning-foreground hover:bg-warning/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }
            disabled:opacity-50 disabled:cursor-not-allowed
          `}
        >
          <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
          <span className="relative z-10 flex items-center justify-center gap-2">
            <Play className="w-4 h-4 fill-current" />
            {runCycle.isPending
              ? "Executing..."
              : evidenceState === "VERIFIED"
                ? "Run Governed Cycle"
                : "Evidence unavailable"}
          </span>
        </button>

        <div className="grid grid-cols-1 gap-2">
          <button
            data-testid="button-verify-ledger"
            onClick={handleVerify}
            disabled={verifierBusy}
            className="flex flex-col items-center justify-center gap-1 rounded-sm border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 text-primary font-mono text-[10px] uppercase tracking-widest py-3 transition disabled:opacity-50"
          >
            <Activity className={`w-4 h-4 ${verifierBusy ? 'animate-spin' : ''}`} />
            {verifierBusy ? "Verifying..." : "Verify Chain"}
          </button>
        </div>
      </div>
    </div>
  );
}
