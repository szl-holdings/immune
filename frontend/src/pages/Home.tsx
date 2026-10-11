import { lazy, Suspense, useEffect, useState } from "react";
import {
  useGetImmuneReadiness,
  useGetImmuneState,
} from "@/lib/immune-api";
import {
  authorityVerificationLabel,
  deriveAuthorityView,
  deriveWholeSystemReadinessView,
  firstPaintSystemStatus,
  initialAuthorityTransportState,
  READINESS_MAX_AGE_MS,
  transitionAuthorityTransportState,
} from "@/lib/authority-view";
import { ControlsPanel } from "@/components/ControlsPanel";
import { AuditConsole } from "@/components/AuditConsole";
import { LatticeCop } from "@/components/LatticeCop";
import AgentConsole from "@/components/AgentConsole";
import InferConsole from "@/components/InferConsole";
import PulsePanel from "@/components/PulsePanel";
import IntelPanel from "@/components/IntelPanel";
import LeadersPanel from "@/components/LeadersPanel";
import FoundationsPanel from "@/components/FoundationsPanel";
import { Activity, ShieldAlert, ShieldCheck, Skull } from "lucide-react";

// The optional illustration is the only Three.js consumer. Source evidence and
// controls render without downloading or initializing its WebGL implementation.
const ThreeScene = lazy(() => import("@/components/ThreeScene").then((module) => ({ default: module.ThreeScene })));

function AuthorityIllustrationSummary() {
  return <div className="immune-scene-fallback"><div className="immune-flow-map"><span>HEART<small>Intent</small></span><span>SENTRA<small>Admission</small></span><span>YAWAR<small>Receipt</small></span></div><p>Illustrative relationship · inspect the evidence above for current state.</p></div>;
}

export default function Home() {
  const [showIllustration, setShowIllustration] = useState(false);
  useEffect(() => {
    document.title = "IMMUNE | Evidence-Scoped AI Defense";
  }, []);

  const stateQuery = useGetImmuneState();
  const readinessQuery = useGetImmuneReadiness();
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
      if (visible && online) {
        void stateQuery.refetch();
        void readinessQuery.refetch();
      }
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
  }, [readinessQuery.refetch, stateQuery.refetch]);

  useEffect(() => {
    const validUntilMs = Date.parse(stateQuery.data?.tripwireState?.validUntil ?? "");
    if (!Number.isFinite(validUntilMs)) return;
    const delay = Math.max(0, Math.min(validUntilMs - Date.now() + 1, 2_147_483_647));
    const timer = window.setTimeout(() => setAuthorityClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [stateQuery.data?.tripwireState?.validUntil]);

  useEffect(() => {
    if (!readinessQuery.dataUpdatedAt) return;
    const delay = Math.max(
      0,
      Math.min(
        readinessQuery.dataUpdatedAt + READINESS_MAX_AGE_MS - Date.now() + 1,
        2_147_483_647,
      ),
    );
    const timer = window.setTimeout(() => setAuthorityClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [readinessQuery.dataUpdatedAt]);

  const observationClock = Math.max(authorityClock, Date.now());
  const authority = deriveAuthorityView(stateQuery.data, stateQuery.error, {
    nowMs: observationClock,
    visible: transport.visible,
    online: transport.online,
    observedAtMs: stateQuery.dataUpdatedAt,
    requiredObservationAfterMs: transport.requiredObservationAfterMs,
  });
  const { mode, deadman, evidenceState } = authority;
  const systemStatus = firstPaintSystemStatus(stateQuery.data, stateQuery.error, authority);
  const authorityLabel = authorityVerificationLabel(
    authority,
    systemStatus === "CONNECTING",
  );
  const authorityLabelColor =
    evidenceState !== "VERIFIED"
      ? "text-warning"
      : deadman
        ? "text-destructive"
        : mode === "PASS"
          ? "text-primary"
          : "text-warning";
  const systemReadiness = deriveWholeSystemReadinessView(
    readinessQuery.data,
    stateQuery.data,
    authority,
    readinessQuery.error,
    {
      nowMs: observationClock,
      observedAtMs: readinessQuery.dataUpdatedAt,
      authorityObservedAtMs: stateQuery.dataUpdatedAt,
      authorityQueryError: stateQuery.error,
      requiredObservationAfterMs: transport.requiredObservationAfterMs,
      visible: transport.visible,
      online: transport.online,
    },
  );
  const readinessLabelColor = systemReadiness.writeReady
    ? "text-primary"
    : systemReadiness.state === "INVALID"
      ? "text-destructive"
      : "text-warning";

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
      <main id="main-content" tabIndex={-1} className="@container/immune relative w-full bg-background text-foreground font-sans">
      <section className="immune-workbench" aria-labelledby="immune-title">
        <header className="immune-intro" data-testid="immune-hud">
          <div>
            <p className="immune-eyebrow">Evidence-scoped AI defense</p>
            <h1 id="immune-title">IMMUNE</h1>
            <p className="immune-lede">Inspect the boundary between intent and execution. Authority, readiness and receipt integrity each have their own evidence.</p>
          </div>
          <aside className="immune-authority-summary" aria-label="Current authority and readiness">
            <div className="immune-status-heading"><StatusIcon /><p className="immune-eyebrow">Current observation</p></div>
            <div className="immune-status-row"><span>Authority State</span><strong className={getStatusColor()} role="status" aria-live="polite">{systemStatus}</strong></div>
            <div className="immune-status-row"><span>Authority evidence</span><strong className={authorityLabelColor}>{authorityLabel}</strong></div>
            <div className="immune-status-row"><span>Whole system</span><strong className={readinessLabelColor} data-testid="whole-system-readiness" role="status" aria-live="polite">{systemReadiness.label}</strong></div>
            <p>Available observations do not grant permission to act. Missing or expired authority keeps governed controls unavailable.</p>
          </aside>
        </header>

        <figure className="immune-visual-card" data-surface="dark">
          <div className="immune-visual-heading"><span>Authority illustration</span><span>Source state projected as form · no measured telemetry</span></div>
          <div id="immune-illustration" className="immune-visual-stage">{showIllustration ? <Suspense fallback={<AuthorityIllustrationSummary />}><ThreeScene authority={authority} /></Suspense> : <AuthorityIllustrationSummary />}</div>
          <div className="immune-illustration-action"><button type="button" aria-controls="immune-illustration" aria-pressed={showIllustration} onClick={() => setShowIllustration(!showIllustration)}>{showIllustration ? "Hide 3D illustration" : "Show 3D illustration"}</button><span>Optional visual · no additional evidence request</span></div>
          <figcaption className="immune-visual-caption"><span>HEART / Intent</span><span>SENTRA / Admission</span><span>YAWAR / Receipt</span></figcaption>
        </figure>

        <div className="immune-workbench-panels kanchay-safe">
          <section
            className="immune-control-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary @5xl/immune:overflow-y-auto @5xl/immune:overscroll-contain [scrollbar-gutter:stable]"
            data-testid="controls-scroll-region" aria-label="Governed controls" role="region" tabIndex={0}
          >
            <div className="immune-panel-label"><Activity className="h-4 w-4" aria-hidden="true" />Governed controls</div>
            <ControlsPanel authority={authority} systemReadiness={systemReadiness} />
          </section>
          <section className="immune-audit-panel" data-testid="audit-panel" aria-label="Cryptographic audit">
            <div className="immune-panel-label">Cryptographic audit / Retrieved evidence</div>
            <AuditConsole authority={authority} />
          </section>
        </div>
      </section>

      <LatticeCop authority={authority} writeReady={systemReadiness.writeReady} />

      {/* ===================== VALUE + PROOF BOUNDARY ===================== */}
      <section className="relative z-20 border-y border-primary/10 bg-card" aria-labelledby="proof-boundary-title">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 @5xl/immune:grid-cols-[1.05fr_1.95fr]">
          <header>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-secondary">
              Evidence brief · scoped to the source
            </p>
            <h2 id="proof-boundary-title" className="mt-3 font-display text-2xl font-bold tracking-widest">
              Governed actions. A replayable audit path.
            </h2>
            <p className="mt-4 max-w-xl font-mono text-xs leading-relaxed text-muted-foreground">
              IMMUNE places admission, tripwire evaluation, and an append-only receipt between intent and execution.
              The value is inspectability: authority and ledger evidence can fail closed without turning an outage into a green claim.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a className="kanchay-action" href="/api/immune/state">Inspect authority JSON</a>
              <a className="kanchay-action" href="/api/immune/ledger/verify">Verify the ledger</a>
            </div>
          </header>

          <div className="grid gap-3 @min-[40rem]/immune:grid-cols-2" aria-label="Evidence state contract">
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
            <aside id="developer-quickstart" className="kanchay-quickstart @min-[40rem]/immune:col-span-2" aria-label="Developer quickstart">
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
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.3em] text-primary">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Source-by-source disclosure
            </div>
            <h2 id="intelligence-title" className="text-2xl @3xl/immune:text-3xl font-display font-bold tracking-widest">
              Evidence feeds with explicit source state
            </h2>
            <p className="font-mono text-xs text-muted-foreground leading-relaxed max-w-3xl">
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

          <InferConsole writeReady={systemReadiness.writeReady} />

          {/* The real math — verbatim from the canonical szl-holdings kernels */}
          <FoundationsPanel />

          {/* Live pulse: NVD CVEs + GitHub/HF ecosystem */}
          <PulsePanel />

          {/* Transparency log (Rekor) + ATLAS case studies | Leaders */}
          <div className="grid @5xl/immune:grid-cols-2 gap-8 items-start">
            <IntelPanel />
            <LeadersPanel />
          </div>

          <footer className="border-t border-border/40 pt-6 font-mono text-xs text-muted-foreground leading-relaxed">
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
