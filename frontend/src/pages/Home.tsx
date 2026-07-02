import { useEffect, useState, useCallback } from "react";
import { ImmuneCycleResult, useGetImmuneState } from "@workspace/api-client-react";
import { ControlsPanel } from "@/components/ControlsPanel";
import { AuditConsole } from "@/components/AuditConsole";
import { ThreeScene } from "@/components/ThreeScene";
import AgentConsole from "@/components/AgentConsole";
import PulsePanel from "@/components/PulsePanel";
import IntelPanel from "@/components/IntelPanel";
import LeadersPanel from "@/components/LeadersPanel";
import FoundationsPanel from "@/components/FoundationsPanel";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, ShieldAlert, ShieldCheck, Skull, ChevronDown } from "lucide-react";

export default function Home() {
  useEffect(() => {
    document.title = "IMMUNE — Verifiable-AI Defense";
  }, []);

  const [lastCycleResult, setLastCycleResult] = useState<ImmuneCycleResult | null>(null);
  const stateQuery = useGetImmuneState();
  const state = stateQuery.data;

  const handleCycleResult = useCallback((result: ImmuneCycleResult) => {
    setLastCycleResult(result);
  }, []);

  const mode = state?.mode ?? "PASS";
  const deadman = state?.deadman ?? false;

  const getStatusColor = () => {
    if (deadman) return "text-destructive shadow-destructive border-destructive/50";
    if (mode === "SENTRA_REJECT") return "text-warning shadow-warning border-warning/50";
    return "text-primary shadow-primary border-primary/50";
  };

  const StatusIcon = () => {
    if (deadman) return <Skull className="w-8 h-8 text-destructive animate-pulse" />;
    if (mode === "SENTRA_REJECT") return <ShieldAlert className="w-8 h-8 text-warning" />;
    return <ShieldCheck className="w-8 h-8 text-primary" />;
  };

  return (
    <div className="relative w-full bg-background text-foreground font-sans">
      {/* ============================ HERO ============================ */}
      <section className="relative flex min-h-[100svh] w-full flex-col overflow-x-hidden lg:h-screen lg:block lg:overflow-hidden">
        {/* 3D Background */}
        <div className="absolute inset-0 z-0">
          <ThreeScene lastCycleResult={lastCycleResult} />
        </div>

        {/* DEADMAN Overlay */}
        <AnimatePresence>
          {deadman && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-10 bg-destructive/10 pointer-events-none mix-blend-overlay"
            >
              <div className="w-full h-full border-[10px] border-destructive/30 animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top HUD */}
        <div className="absolute top-0 left-0 w-full p-4 sm:p-6 z-30 flex justify-between items-start gap-3 pointer-events-none">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-4">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5 }}
                className={`p-3 border bg-black/60 backdrop-blur-md ${getStatusColor()}`}
              >
                <StatusIcon />
              </motion.div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-widest leading-none flex items-center gap-3">
                  <span className={deadman ? "glitch-text text-destructive" : ""}>IMMUNE</span>
                </h1>
                <p className="hidden sm:block text-muted-foreground font-mono text-xs uppercase tracking-[0.2em] mt-1">
                  Verifiable-AI Defense Matrix
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 font-mono text-[10px] sm:text-xs uppercase tracking-widest">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">System Status</span>
              <span className={`px-2 py-1 bg-black/50 border ${getStatusColor()} backdrop-blur`}>
                {deadman ? "FROZEN" : mode}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Activity className="w-3 h-3 text-primary" />
              <span className="text-primary/70">Live Uplink</span>
            </div>
          </div>
        </div>

        {/* Panels: stacked in normal flow on mobile/tablet, absolute HUD on desktop (lg:contents) */}
        <div className="relative z-20 flex w-full flex-col gap-4 px-4 pb-10 pt-24 sm:px-6 lg:contents">
          {/* Left Panel: Controls */}
          <motion.div
            initial={{ x: -60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 20 }}
            className="w-full pointer-events-auto flex flex-col gap-6 lg:absolute lg:left-6 lg:top-32 lg:bottom-6 lg:w-[320px]"
          >
            <div className="flex-1 bg-black/40 backdrop-blur-md border border-border/50 p-5 sm:p-6 flex flex-col relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/50 to-transparent" />
              <ControlsPanel onCycleComplete={handleCycleResult} />
            </div>
          </motion.div>

          {/* Right Panel: Audit/Ledger */}
          <motion.div
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.3, type: "spring", stiffness: 200, damping: 20 }}
            className="w-full pointer-events-auto flex flex-col gap-6 lg:absolute lg:right-6 lg:top-32 lg:bottom-6 lg:w-[400px]"
          >
            <div className="flex-1 bg-black/40 backdrop-blur-md border border-border/50 p-5 sm:p-6 flex flex-col relative overflow-hidden">
              <div className="absolute top-0 right-0 w-full h-1 bg-gradient-to-l from-primary/50 to-transparent" />
              <div className="text-[10px] text-primary/70 uppercase tracking-[0.3em] mb-6 font-mono flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Cryptographic Audit
              </div>
              <AuditConsole />
            </div>
          </motion.div>
        </div>

        {/* Target Reticle overlays */}
        <div className="absolute inset-0 pointer-events-none hidden lg:flex items-center justify-center z-10 opacity-20">
          <div className="w-[60vw] h-[60vh] border border-primary/20 rounded-full relative">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-8 bg-primary/50" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-px h-8 bg-primary/50" />
            <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-px bg-primary/50" />
            <div className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-8 h-px bg-primary/50" />
          </div>
        </div>

        {/* Scroll cue -> Live Intelligence */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none"
        >
          <span className="font-mono text-[9px] uppercase tracking-[0.3em] text-primary/60">
            Live Intelligence
          </span>
          <ChevronDown className="w-4 h-4 text-primary/60 animate-bounce" />
        </motion.div>
      </section>

      {/* ===================== LIVE INTELLIGENCE ===================== */}
      <section className="relative z-20 bg-background border-t border-primary/10">
        <div className="max-w-6xl mx-auto px-6 py-20 flex flex-col gap-12">
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-primary/70">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Verifiable AI · You Can't Fake It
            </div>
            <h2 className="text-2xl md:text-3xl font-display font-bold tracking-widest">
              WIRED TO REAL, LIVE, INDUSTRY-STANDARD DATA
            </h2>
            <p className="font-mono text-[11px] text-muted-foreground leading-relaxed max-w-3xl">
              IMMUNE's append-only receipt chain is the same principle public transparency logs use —
              applied to every AI-agent action. The feeds below are pulled live from public sources at
              view time and labelled honestly:
              <span className="text-primary"> LIVE</span> (fetched now),
              <span className="text-secondary"> REFERENCE</span> (curated real facts with citations), and
              <span className="text-warning"> UNAVAILABLE</span> (feed down — shown plainly, never faked).
            </p>
          </header>

          {/* Marquee: a REAL governed agent on SZL's own inference */}
          <AgentConsole />

          {/* The real math — verbatim from the canonical szl-holdings kernels */}
          <FoundationsPanel />

          {/* Live pulse: NVD CVEs + GitHub/HF ecosystem */}
          <PulsePanel />

          {/* Transparency log (Rekor) + ATLAS case studies | Leaders */}
          <div className="grid lg:grid-cols-2 gap-8 items-start">
            <IntelPanel />
            <LeadersPanel />
          </div>

          <footer className="border-t border-border/40 pt-6 font-mono text-[9px] text-muted-foreground/50 leading-relaxed">
            Provenance is enforced end-to-end: the receipt chain is real SHA-256 over canonical bytes,
            the transparency count is a live read of Sigstore Rekor, and every external link resolves to
            its real public source. Nothing on this page is fabricated.
          </footer>
        </div>
      </section>
    </div>
  );
}
