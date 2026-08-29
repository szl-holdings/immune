import { useEffect, useState } from "react";
import { useGetImmuneState } from "@/lib/immune-api";
import {
  deriveAuthorityView,
  firstPaintSystemStatus,
  initialAuthorityTransportState,
  transitionAuthorityTransportState,
} from "@/lib/authority-view";
import { ControlsPanel } from "@/components/ControlsPanel";
import { AuditConsole } from "@/components/AuditConsole";
import { ThreeScene } from "@/components/ThreeScene";
import { LatticeCop } from "@/components/LatticeCop";
import AgentConsole from "@/components/AgentConsole";
import InferConsole from "@/components/InferConsole";
import PulsePanel from "@/components/PulsePanel";
import IntelPanel from "@/components/IntelPanel";
import LeadersPanel from "@/components/LeadersPanel";
import FoundationsPanel from "@/components/FoundationsPanel";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, ShieldAlert, ShieldCheck, Skull, ChevronDown } from "lucide-react";

export default function Home() {
  useEffect(() => {
    document.title = "IMMUNE | Evidence-Scoped AI Defense";
  }, []);

  const stateQuery = useGetImmuneState();
  const [authorityClock, setAuthorityClock] = useState(() => Date.now());
  const [transport, setTransport] = useState(initialAuthorityTransportState);

  useEffect(() => {
    const updateTransport = () => {
      const visible = document.visibilityState === "visible";
      const online = navigator.onLine;
      const now = Date.now();
      setAuthorityClock(now);
      setTransport((current) =>
        transitionAuthorityTransportState(current, now, visible, online),
      );
      if (visible && online) void stateQuery.refetch();
    };
    document.addEventListener("visibilitychange", updateTransport);
    window.addEventListener("online", updateTransport);
    window.addEventListener("offline", updateTransport);
    updateTransport();
    return () => {
      document.removeEventListener("visibilitychange", updateTransport);
      window.removeEventListener("online", updateTransport);
      window.removeEventListener("offline", updateTransport);
    };
  }, [stateQuery.refetch]);

  useEffect(() => {
    const validUntilMs = Date.parse(stateQuery.data?.tripwireState?.validUntil ?? "");
    if (!Number.isFinite(validUntilMs)) return;
    const delay = Math.max(0, Math.min(validUntilMs - Date.now() + 1, 2_147_483_647));
    const timer = window.setTimeout(() => setAuthorityClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [stateQuery.data?.tripwireState?.validUntil]);

  const authority = deriveAuthorityView(stateQuery.data, stateQuery.error, {
    nowMs: authorityClock,
    visible: transport.visible,
    online: transport.online,
    observedAtMs: stateQuery.dataUpdatedAt,
    requiredObservationAfterMs: transport.requiredObservationAfterMs,
  });
  const { mode, deadman, evidenceState } = authority;
  const systemStatus = firstPaintSystemStatus(stateQuery.data, stateQuery.error, authority);

  const getStatusColor = () => {
    if (evidenceState === "FAILED") return "text-destructive shadow-destructive border-destructive/50";
    if (evidenceState !== "VERIFIED") return "text-warning shadow-warning border-warning/50";
    if (deadman) return "text-destructive shadow-destructive border-destructive/50";
    if (mode === "SENTRA_REJECT") return "text-warning shadow-warning border-warning/50";
    return "text-primary shadow-primary border-primary/50";
  };

  const StatusIcon = () => {
    if (evidenceState !== "VERIFIED") return <ShieldAlert className="w-8 h-8 text-warning" />;
    if (deadman) return <Skull className="w-8 h-8 text-destructive animate-pulse" />;
    if (mode === "SENTRA_REJECT") return <ShieldAlert className="w-8 h-8 text-warning" />;
    return <ShieldCheck className="w-8 h-8 text-primary" />;
  };

  return (
    <>
      <a className="kanchay-skip" href="#main-content">
        Skip to evidence
      </a>
      <main id="main-content" className="relative w-full bg-background text-foreground font-sans">
      {/* ============================ HERO ============================ */}
      <section
        className="relative flex min-h-[100svh] w-full flex-col overflow-x-hidden lg:h-screen lg:block lg:overflow-hidden"
        aria-labelledby="immune-title"
      >
        {/* 3D Background */}
        <div className="absolute inset-0 z-0">
          <ThreeScene authority={authority} />
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
        <header className="absolute top-0 left-0 w-full p-4 sm:p-6 z-30 flex justify-between items-start gap-3 pointer-events-none">
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
                <h1 id="immune-title" className="text-2xl sm:text-3xl font-display font-bold tracking-widest leading-none flex items-center gap-3">
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
              <span
                className={`px-2 py-1 bg-black/50 border ${getStatusColor()} backdrop-blur`}
                role="status"
                aria-live="polite"
              >
                {systemStatus}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Activity className={`w-3 h-3 ${evidenceState === "VERIFIED" ? "text-primary" : "text-warning"}`} />
              <span className={evidenceState === "VERIFIED" ? "text-primary/70" : "text-warning"}>
                {evidenceState === "VERIFIED" ? "Write-ready authority" : "Connecting"}
              </span>
            </div>
          </div>
        </header>

        {/* Panels: stacked in normal flow on mobile/tablet, absolute HUD on desktop (lg:contents) */}
        <div className="kanchay-safe relative z-20 flex w-full flex-col gap-4 px-4 pb-10 pt-24 sm:px-6 lg:contents">
          {/* Left Panel: Controls */}
          <motion.div
            initial={{ x: -60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 20 }}
            className="w-full pointer-events-auto flex flex-col gap-6 lg:absolute lg:left-6 lg:top-32 lg:bottom-6 lg:min-h-0 lg:w-[320px]"
          >
            <div
              aria-label="Governed controls"
              className="group relative flex flex-1 flex-col border border-border/50 bg-black/40 p-5 backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-6 lg:min-h-0 lg:overflow-x-hidden lg:overflow-y-auto lg:overscroll-contain [scrollbar-gutter:stable]"
              data-testid="controls-scroll-region"
              role="region"
              tabIndex={0}
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/50 to-transparent" />
              <ControlsPanel authority={authority} />
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
              <AuditConsole authority={authority} />
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

      <LatticeCop authority={authority} />

      {/* ===================== VALUE + PROOF BOUNDARY ===================== */}
      <section className="relative z-20 border-y border-primary/10 bg-black/70" aria-labelledby="proof-boundary-title">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 lg:grid-cols-[1.05fr_1.95fr]">
          <header>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-secondary">
              Investor brief · proof before posture
            </p>
            <h2 id="proof-boundary-title" className="mt-3 font-display text-2xl font-bold tracking-widest">
              GOVERNED ACTIONS WITH A REPLAYABLE AUDIT PATH
            </h2>
            <p className="mt-4 max-w-xl font-mono text-[11px] leading-relaxed text-muted-foreground">
              IMMUNE places admission, tripwire evaluation, and an append-only receipt between intent and execution.
              The value is inspectability: authority and ledger evidence can fail closed without turning an outage into a green claim.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a className="kanchay-action" href="/api/immune/state">Inspect authority JSON</a>
              <a className="kanchay-action" href="/api/immune/ledger/verify">Verify the ledger</a>
            </div>
          </header>

          <div className="grid gap-3 sm:grid-cols-2" aria-label="Evidence state contract">
            <article className="kanchay-proof-card">
              <h3>LIVE / MEASURED</h3>
              <p>Reserved for a current successful API observation. Authority expires and transport loss invalidates cached green state.</p>
            </article>
            <article className="kanchay-proof-card">
              <h3>DERIVED</h3>
              <p>Chain verification and summaries are computed from retrieved receipt bytes; they do not establish outcome quality.</p>
            </article>
            <article className="kanchay-proof-card">
              <h3>MODELED / SAMPLE</h3>
              <p>Frontier recommendations are non-executable MODELED output. Sample or demonstration input is never promoted to measured evidence.</p>
            </article>
            <article className="kanchay-proof-card">
              <h3>UNAVAILABLE / LIMITS</h3>
              <p>Missing, stale, contradictory, or unreachable authority fails closed. Public readback is not an ATO or a performance claim.</p>
            </article>
            <aside className="kanchay-quickstart sm:col-span-2" aria-label="Developer quickstart">
              <strong>Developer quickstart</strong>
              <code>pnpm install --frozen-lockfile</code>
              <code>pnpm run typecheck</code>
              <code>pnpm run build</code>
              <span>Run locally before treating any UI state as observed.</span>
            </aside>
          </div>
        </div>
      </section>

      {/* ===================== LIVE INTELLIGENCE ===================== */}
      <section className="relative z-20 bg-background border-t border-primary/10" aria-labelledby="intelligence-title">
        <div className="max-w-6xl mx-auto px-6 py-20 flex flex-col gap-12">
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-primary/70">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Verifiable AI · You Can't Fake It
            </div>
            <h2 id="intelligence-title" className="text-2xl md:text-3xl font-display font-bold tracking-widest">
              EVIDENCE FEEDS WITH SOURCE-BY-SOURCE STATE
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

          <InferConsole />

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
            The server recomputes the SHA-256 receipt chain over canonical bytes. External feeds retain
            their individual provenance state; unavailable sources remain visible and are never promoted
            to live evidence.
          </footer>
        </div>
      </section>
      </main>
    </>
  );
}
