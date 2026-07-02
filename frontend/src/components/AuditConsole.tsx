import { useMemo, useState } from "react";
import {
  useGetImmuneState,
  useGetImmuneLedgerLatest,
  useVerifyImmuneLedger,
  type ImmuneReceipt,
} from "@workspace/api-client-react";
import { motion, AnimatePresence } from "framer-motion";
import { Terminal, Database, ShieldAlert, CheckCircle2, ChevronRight, XCircle, Unlink } from "lucide-react";
import { getWatcherFramework } from "@/lib/frameworks";

const HUKLLA_NAMES: Record<string, string> = {
  T01: "intent.unsigned",
  T02: "actor.unknown",
  T03: "rate.exceeded",
  T04: "payload.oversize",
  T05: "egress.unauthorized",
  T06: "ledger.divergence",
  T07: "deadman.engaged",
  T08: "sentra.bypass",
  T09: "clock.skew",
  T10: "evidence.gap",
};

function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  if (h === "GENESIS") return "GENESIS";
  return h.slice(0, 16) + "…";
}

export function AuditConsole() {
  const stateQuery = useGetImmuneState();
  const ledgerQuery = useGetImmuneLedgerLatest();
  const verifierQuery = useVerifyImmuneLedger();
  const [openReceipt, setOpenReceipt] = useState<number | null>(null);
  const [tamperedSeq, setTamperedSeq] = useState<number | null>(null);

  const state = stateQuery.data;
  const ledger = ledgerQuery.data;
  const verifier = verifierQuery.data;

  // Client-side tamper-evidence: altering any receipt changes its hash, so the
  // NEXT receipt's prevHash (a plain string compare against the real ledger)
  // no longer matches — the chain visibly breaks. This is simulated on a copy
  // in the browser; the server ledger is never touched.
  const sortedAsc = useMemo(
    () => [...(ledger?.entries ?? [])].sort((a, b) => a.seq - b.seq),
    [ledger],
  );

  const tamperAnalysis = useMemo(() => {
    if (tamperedSeq == null) return null;
    const idx = sortedAsc.findIndex((r) => r.seq === tamperedSeq);
    if (idx === -1) return null;
    const next = sortedAsc[idx + 1];
    return next
      ? { kind: "link" as const, tamperedSeq, brokenSeq: next.seq }
      : { kind: "head" as const, tamperedSeq, brokenSeq: null as number | null };
  }, [tamperedSeq, sortedAsc]);

  const isDeadman = state?.mode === "DEADMAN";
  const isReject = state?.mode === "SENTRA_REJECT";
  
  const modeBadgeClass = isDeadman
    ? "border-destructive text-destructive bg-destructive/10"
    : isReject
      ? "border-warning text-warning bg-warning/10"
      : "border-primary text-primary bg-primary/10";

  return (
    <div className="flex flex-col gap-6 text-xs overflow-y-auto pr-2 custom-scrollbar h-full relative z-10">
      
      {/* Primary Readouts */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-black/50 border border-border/50 p-3 rounded-sm">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground mb-2 font-mono flex items-center gap-1.5">
            <Terminal className="w-3 h-3" /> Mode
          </div>
          <div className={`inline-block px-2 py-1 rounded-sm border font-display font-bold text-[10px] tracking-widest ${modeBadgeClass}`}>
            {state?.mode ?? "—"}
          </div>
        </div>

        <div className={`bg-black/50 border p-3 rounded-sm transition-colors ${isDeadman ? 'border-destructive/50' : 'border-border/50'}`}>
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground mb-2 font-mono flex items-center gap-1.5">
            <ShieldAlert className="w-3 h-3" /> Kill-Switch
          </div>
          <div className={`font-display font-bold text-xs tracking-widest ${isDeadman ? "text-destructive glitch-text" : "text-primary/70"}`}>
            {isDeadman ? "ENGAGED" : "STANDBY"}
          </div>
        </div>
      </div>

      {/* Ledger State */}
      <div className="bg-black/50 border border-border/50 p-3 rounded-sm space-y-3">
        <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5 border-b border-border/50 pb-2">
          <Database className="w-3 h-3" /> Yawar Ledger Status
        </div>
        
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[9px] text-muted-foreground font-mono mb-1">Receipts</div>
            <div className="font-display font-bold text-xl text-foreground">
              {state?.ledgerCount ?? 0}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground font-mono mb-1">Latest Hash (SHA-256)</div>
            <div className="font-mono text-[10px] text-primary break-all leading-tight" title={state?.lastHash ?? ""}>
              {shortHash(state?.lastHash)}
            </div>
          </div>
        </div>
      </div>

      {/* Verifier Report */}
      <div className={`bg-black/50 border p-3 rounded-sm ${verifier && !verifier.ok ? 'border-destructive/50' : 'border-border/50'}`}>
        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5">
            {verifier && !verifier.ok ? <XCircle className="w-3 h-3 text-destructive" /> : <CheckCircle2 className="w-3 h-3 text-primary" />} 
            Chain Verification
          </div>
          {verifierQuery.isFetching && (
            <span className="text-[9px] text-primary animate-pulse font-mono">Running...</span>
          )}
        </div>
        
        <div className={`font-mono text-[11px] ${verifier?.ok ? "text-primary" : "text-destructive"}`}>
          {verifier
            ? verifier.ok
              ? `[ OK ] Verified ${verifier.count} blocks independently`
              : `[ ALERT ] TAMPERED at sequence ${verifier.firstBadSeq ?? "?"}`
            : "—"}
        </div>
        
        {verifier && !verifier.ok && (
          <div className="mt-3 space-y-1.5 max-h-32 overflow-y-auto">
            {verifier.issues.map((iss, i) => (
              <div
                key={i}
                className="font-mono text-[9px] text-destructive border-l-2 border-destructive pl-2 py-1 bg-destructive/5"
              >
                <div className="font-bold opacity-80">Seq {iss.seq} :: {iss.kind}</div>
                <div className="opacity-60">{iss.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tamper-Evidence (client-side simulation on a copy) */}
      {tamperAnalysis && (
        <div className="bg-black/50 border border-destructive/50 p-3 rounded-sm">
          <div className="flex items-center justify-between border-b border-destructive/30 pb-2 mb-3">
            <div className="text-[9px] uppercase tracking-[0.2em] text-destructive font-mono flex items-center gap-1.5">
              <Unlink className="w-3 h-3" /> Tamper-Evidence · Client-Side
            </div>
            <button
              data-testid="button-restore-tamper"
              onClick={() => setTamperedSeq(null)}
              className="text-[9px] font-mono text-primary/70 hover:text-primary uppercase tracking-widest"
            >
              Restore
            </button>
          </div>
          <div className="font-mono text-[11px] text-destructive">
            {tamperAnalysis.kind === "link"
              ? `[ BROKEN ] receipt #${tamperAnalysis.brokenSeq} prevHash no longer matches altered #${tamperAnalysis.tamperedSeq}`
              : `[ BROKEN ] altered head #${tamperAnalysis.tamperedSeq} no longer matches published lastHash`}
          </div>
          <div className="mt-2 text-[9px] font-mono text-muted-foreground leading-relaxed">
            Simulated on a copy in your browser. The server ledger is untouched — run Verify Chain to confirm it still reads OK.
          </div>
        </div>
      )}

      {/* Tripwire Registry — aligned to public frameworks (OUR mapping) */}
      <div className="bg-black/50 border border-border/50 p-3 rounded-sm">
        <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono border-b border-border/50 pb-2 mb-1">
          Huklla Watchers · Framework Alignment
        </div>
        <div className="text-[8px] font-mono text-muted-foreground/50 mb-3 leading-relaxed">
          IMMUNE's own alignment to the OWASP LLM Top 10 (2025) &amp; MITRE ATLAS — not an official mapping.
        </div>
        <div className="flex flex-col gap-1.5">
          {Object.entries(HUKLLA_NAMES).map(([id, name]) => {
            const isFired = isDeadman && state?.tripwire === id;
            const fw = getWatcherFramework(id);
            return (
              <div
                key={id}
                className={`flex items-center gap-1.5 font-mono text-[9px] ${isFired ? 'text-destructive font-bold bg-destructive/10 -mx-1 px-1 rounded-sm py-0.5' : 'text-muted-foreground'}`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isFired ? 'bg-destructive animate-pulse' : 'bg-primary/20'}`} />
                <span className={`shrink-0 ${isFired ? "text-destructive" : "text-foreground/50"}`}>{id}</span>
                <span className="truncate" title={name}>{name}</span>
                {fw && (
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    <a
                      href={fw.owasp.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={fw.alignmentNote}
                      data-testid={`badge-owasp-${id}`}
                      className="px-1 py-0.5 rounded-sm border border-secondary/40 text-secondary/90 hover:border-secondary hover:text-secondary text-[8px] tracking-wider transition-colors"
                    >
                      {fw.owasp.id}
                    </a>
                    <a
                      href={fw.atlas.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={fw.atlas.title}
                      data-testid={`badge-atlas-${id}`}
                      className="px-1 py-0.5 rounded-sm border border-primary/30 text-primary/80 hover:border-primary hover:text-primary text-[8px] tracking-wider transition-colors"
                    >
                      ATLAS
                    </a>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Ledger Tail Log */}
      <div className="bg-black/50 border border-border/50 p-3 rounded-sm flex-1 flex flex-col min-h-0">
        <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono border-b border-border/50 pb-2 mb-3 shrink-0">
          Append Log
        </div>
        
        <div className="flex flex-col gap-1.5 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {(ledger?.entries ?? []).slice(0, 10).map((r: ImmuneReceipt) => {
              const open = openReceipt === r.seq;
              const tampered = tamperedSeq === r.seq;
              const broken =
                tamperAnalysis?.kind === "link" && tamperAnalysis.brokenSeq === r.seq;
              return (
                <motion.div
                  key={r.seq}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`border rounded-sm font-mono text-[9px] overflow-hidden transition-colors ${tampered || broken ? 'border-destructive/60' : open ? 'border-primary/50' : 'border-border/30'}`}
                >
                  <div
                    className={`flex items-stretch ${tampered ? 'bg-destructive/15' : broken ? 'bg-destructive/5' : open ? 'bg-primary/10' : 'bg-black/40'}`}
                  >
                    <button
                      onClick={() => setOpenReceipt(open ? null : r.seq)}
                      className="flex-1 text-left px-2 py-1.5 flex items-center gap-2 transition-colors hover:bg-white/5"
                    >
                      <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90 text-primary' : 'text-muted-foreground'}`} />
                      <span className="text-secondary/80 shrink-0">#{r.seq}</span>
                      <span className="text-muted-foreground/60 shrink-0">{r.ts.slice(11, 23)}</span>
                      {broken && <span className="text-destructive text-[8px] shrink-0">prev!=</span>}
                      <span className={`ml-auto truncate ${tampered ? 'text-destructive line-through' : broken ? 'text-destructive/70' : 'text-primary/70'}`}>
                        {shortHash(r.hash)}
                      </span>
                    </button>
                    <button
                      data-testid={`button-tamper-${r.seq}`}
                      onClick={() => setTamperedSeq(tampered ? null : r.seq)}
                      title="Simulate tampering with this receipt (client-side)"
                      className={`px-2 flex items-center border-l transition-colors ${tampered ? 'border-destructive/40 text-destructive bg-destructive/20' : 'border-border/30 text-muted-foreground hover:text-destructive hover:bg-destructive/10'}`}
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                  <AnimatePresence>
                    {open && (
                      <motion.pre
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="bg-black/60 border-t border-border/30 px-3 py-2 text-[10px] text-primary/60 whitespace-pre-wrap break-all overflow-hidden"
                      >
                        {JSON.stringify(r.payload, null, 2)}
                      </motion.pre>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {(!ledger || ledger.entries.length === 0) && (
            <div className="font-mono text-[10px] text-muted-foreground italic text-center py-4 opacity-50">
              [ empty buffer — awaiting ingress ]
            </div>
          )}
        </div>
      </div>

    </div>
  );
}