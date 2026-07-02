import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldAlert, Skull, Activity, Play, RotateCcw, AlertTriangle } from "lucide-react";
import {
  useGetImmuneState,
  useSetImmuneState,
  useRunImmuneCycle,
  useResetImmune,
  getGetImmuneStateQueryKey,
  getGetImmuneLedgerLatestQueryKey,
  getVerifyImmuneLedgerQueryKey,
  getGetImmuneEvidenceLatestQueryKey,
  type ImmuneCycleResult,
  type ImmuneMode,
} from "@workspace/api-client-react";

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

export function ControlsPanel({
  onCycleComplete,
}: {
  onCycleComplete: (r: ImmuneCycleResult) => void;
}) {
  const qc = useQueryClient();
  const stateQuery = useGetImmuneState();
  const setMode = useSetImmuneState();
  const runCycle = useRunImmuneCycle();
  const resetMutation = useResetImmune();

  const currentMode: ImmuneMode = stateQuery.data?.mode ?? "PASS";
  const currentTripwire = stateQuery.data?.tripwire ?? "T07";
  const [pendingTripwire, setPendingTripwire] = useState<string>(currentTripwire ?? "T07");
  const [verifierBusy, setVerifierBusy] = useState(false);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: getGetImmuneStateQueryKey() });
    qc.invalidateQueries({ queryKey: getGetImmuneLedgerLatestQueryKey() });
    qc.invalidateQueries({ queryKey: getVerifyImmuneLedgerQueryKey() });
    qc.invalidateQueries({ queryKey: getGetImmuneEvidenceLatestQueryKey() });
  };

  const handleSetMode = (mode: ImmuneMode) => {
    const tripwire = mode === "DEADMAN" ? pendingTripwire : undefined;
    setMode.mutate(
      { data: { mode, tripwire: tripwire as any } },
      { onSuccess: invalidateAll },
    );
  };

  const handleRun = () => {
    runCycle.mutate(
      { data: { actor: "operator@immune.demo", intent: "DEMO: inject payload" } },
      {
        onSuccess: (result) => {
          onCycleComplete(result);
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

  const handleReset = () => {
    resetMutation.mutate(undefined, { onSuccess: invalidateAll });
  };

  return (
    <div className="flex flex-col h-full gap-8 z-10 relative">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          <h2 className="text-primary text-[10px] font-mono uppercase tracking-[0.3em]">Threat Vector</h2>
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
                onClick={() => handleSetMode(m.id)}
                disabled={setMode.isPending}
                className={`
                  relative overflow-hidden text-left rounded-sm border p-3 transition-all duration-300 flex items-center gap-3
                  ${active
                    ? isDanger
                      ? m.id === "DEADMAN" 
                        ? "border-destructive bg-destructive/20 text-destructive shadow-[0_0_15px_rgba(255,0,0,0.3)]"
                        : "border-warning bg-warning/20 text-warning shadow-[0_0_15px_rgba(255,170,0,0.3)]"
                      : "border-primary bg-primary/20 text-primary shadow-[0_0_15px_rgba(0,255,255,0.2)]"
                    : "border-border bg-black/40 hover:border-primary/50 hover:bg-black/60 text-muted-foreground"
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
          <select
            data-testid="select-tripwire"
            value={pendingTripwire}
            onChange={(e) => {
              setPendingTripwire(e.target.value);
              setMode.mutate(
                { data: { mode: "DEADMAN", tripwire: e.target.value as any } },
                { onSuccess: invalidateAll },
              );
            }}
            className="w-full bg-black/60 border border-destructive/50 rounded-sm px-3 py-2.5 text-xs font-mono text-destructive focus:outline-none focus:border-destructive focus:ring-1 focus:ring-destructive"
          >
            {TRIPWIRES.map((t) => (
              <option key={t.id} value={t.id} className="bg-background text-destructive">
                {t.id} // {t.name}
              </option>
            ))}
          </select>
        </motion.div>
      )}

      <div className="mt-auto flex flex-col gap-3">
        <button
          data-testid="button-run-cycle"
          onClick={handleRun}
          disabled={runCycle.isPending}
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
            {runCycle.isPending ? "Executing..." : "Inject Intent"}
          </span>
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            data-testid="button-verify-ledger"
            onClick={handleVerify}
            disabled={verifierBusy}
            className="flex flex-col items-center justify-center gap-1 rounded-sm border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 text-primary font-mono text-[10px] uppercase tracking-widest py-3 transition disabled:opacity-50"
          >
            <Activity className={`w-4 h-4 ${verifierBusy ? 'animate-spin' : ''}`} />
            {verifierBusy ? "Verifying..." : "Verify Chain"}
          </button>
          
          <button
            data-testid="button-reset"
            onClick={handleReset}
            disabled={resetMutation.isPending}
            className="flex flex-col items-center justify-center gap-1 rounded-sm border border-border/50 bg-black/40 hover:bg-white/5 hover:text-foreground hover:border-border text-muted-foreground font-mono text-[10px] uppercase tracking-widest py-3 transition disabled:opacity-50"
          >
            <RotateCcw className={`w-4 h-4 ${resetMutation.isPending ? 'animate-spin' : ''}`} />
            Reset State
          </button>
        </div>
      </div>
    </div>
  );
}