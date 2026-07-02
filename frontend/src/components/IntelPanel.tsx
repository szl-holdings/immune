import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Radio,
  Link2,
  Crosshair,
  ExternalLink,
  Loader2,
  WifiOff,
  AlertTriangle,
} from "lucide-react";

const API_BASE = `${import.meta.env.BASE_URL || "/"}api/immune`;

interface Transparency {
  source: string;
  provenance: "LIVE" | "UNAVAILABLE";
  fetchedAt: string;
  treeSize?: number;
  rootHash?: string;
  url: string;
  note?: string;
}

interface CaseStudy {
  id: string;
  name: string;
  summary: string;
  url: string;
}

interface Incidents {
  source: string;
  provenance: "REFERENCE";
  caseStudies: CaseStudy[];
}

type Async<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  if (h.length <= 24) return h;
  return `${h.slice(0, 14)}…${h.slice(-8)}`;
}

// Honest count-up: animates 0 -> the REAL fetched value. Never displays a
// fabricated number; only runs once a finite treeSize arrives from the server.
function useCountUp(target: number | undefined, durationMs = 1400): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      setValue(0);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return value;
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function ProvenancePill({
  kind,
}: {
  kind: "LIVE" | "UNAVAILABLE" | "REFERENCE";
}) {
  const cls =
    kind === "LIVE"
      ? "border-primary/60 text-primary bg-primary/10"
      : kind === "REFERENCE"
        ? "border-secondary/60 text-secondary bg-secondary/10"
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

export default function IntelPanel() {
  const [transparency, setTransparency] = useState<Async<Transparency>>({
    status: "loading",
  });
  const [incidents, setIncidents] = useState<Async<Incidents>>({
    status: "loading",
  });

  // Transparency feed is LIVE — refetch on an interval that mirrors the
  // server-side ~60s cache so the count stays current without hammering Rekor.
  useEffect(() => {
    let controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    let active = true;

    const load = async (showLoading: boolean) => {
      controller.abort();
      controller = new AbortController();
      if (showLoading) setTransparency({ status: "loading" });
      try {
        const data = await fetchJson<Transparency>(
          "/intel/transparency",
          controller.signal,
        );
        if (active) setTransparency({ status: "ok", data });
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setTransparency({
          status: "error",
          error: err instanceof Error ? err.message : "request failed",
        });
      }
    };

    load(true);
    timer = setInterval(() => load(false), 60_000);

    return () => {
      active = false;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    (async () => {
      try {
        const data = await fetchJson<Incidents>(
          "/intel/incidents",
          controller.signal,
        );
        if (active) setIncidents({ status: "ok", data });
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setIncidents({
          status: "error",
          error: err instanceof Error ? err.message : "request failed",
        });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const liveTree =
    transparency.status === "ok" && transparency.data.provenance === "LIVE"
      ? transparency.data.treeSize
      : undefined;
  const counted = useCountUp(liveTree);

  return (
    <div className="flex flex-col gap-6 text-xs overflow-y-auto pr-2 custom-scrollbar h-full relative z-10">
      {/* (a) TRANSPARENCY LOG — LIVE (Sigstore Rekor) */}
      <div
        className={`bg-black/50 border p-3 rounded-sm ${
          transparency.status === "ok" &&
          transparency.data.provenance === "LIVE"
            ? "border-primary/40"
            : "border-border/50"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5">
            <Radio className="w-3 h-3" /> Transparency Log — Live
          </div>
          {transparency.status === "ok" ? (
            <ProvenancePill kind={transparency.data.provenance} />
          ) : transparency.status === "error" ? (
            <ProvenancePill kind="UNAVAILABLE" />
          ) : (
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
          )}
        </div>

        {transparency.status === "loading" && (
          <div className="font-mono text-[10px] text-muted-foreground flex items-center gap-2 py-3">
            <Loader2 className="w-3 h-3 animate-spin" />
            Querying Sigstore Rekor…
          </div>
        )}

        {transparency.status === "error" && (
          <div className="font-mono text-[11px] text-warning flex items-center gap-2 py-3">
            <WifiOff className="w-3.5 h-3.5 shrink-0" />
            <span>[ UNAVAILABLE ] transparency feed unreachable — no number to show</span>
          </div>
        )}

        {transparency.status === "ok" &&
          transparency.data.provenance === "UNAVAILABLE" && (
            <div className="font-mono text-[11px] text-warning flex items-center gap-2 py-3">
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
              <span>[ UNAVAILABLE ] Rekor fetch failed server-side — treeSize withheld</span>
            </div>
          )}

        {transparency.status === "ok" &&
          transparency.data.provenance === "LIVE" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[9px] text-muted-foreground font-mono mb-1">
                    Rekor Tree Size
                  </div>
                  <motion.div
                    key="treeSize"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="font-display font-bold text-2xl text-primary leading-none tabular-nums"
                  >
                    {counted.toLocaleString()}
                  </motion.div>
                  <div className="text-[8px] text-muted-foreground/60 font-mono mt-1">
                    entries logged
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-muted-foreground font-mono mb-1">
                    Root Hash (SHA-256)
                  </div>
                  <div
                    className="font-mono text-[10px] text-primary break-all leading-tight"
                    title={transparency.data.rootHash ?? ""}
                  >
                    {shortHash(transparency.data.rootHash)}
                  </div>
                  <div className="text-[8px] text-muted-foreground/60 font-mono mt-1">
                    fetched {transparency.data.fetchedAt.slice(11, 19)}Z
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2 border-t border-border/30 pt-3">
                <Link2 className="w-3 h-3 text-primary/70 mt-0.5 shrink-0" />
                <p className="text-[9px] font-mono text-muted-foreground leading-relaxed">
                  {transparency.data.note ??
                    "IMMUNE applies the same append-only hash-chain principle to every AI-agent action — each receipt links to the last, so tampering breaks the chain."}
                </p>
              </div>

              <a
                href={transparency.data.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-rekor-source"
                className="inline-flex items-center gap-1.5 font-mono text-[9px] text-primary/70 hover:text-primary uppercase tracking-widest transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                rekor.sigstore.dev
              </a>
            </div>
          )}
      </div>

      {/* (b) REAL-WORLD ATTACK CASE STUDIES (MITRE ATLAS) */}
      <div className="bg-black/50 border border-border/50 p-3 rounded-sm flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3 shrink-0">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5">
            <Crosshair className="w-3 h-3" /> Real-World Attack Case Studies
          </div>
          {incidents.status === "ok" ? (
            <ProvenancePill kind="REFERENCE" />
          ) : incidents.status === "loading" ? (
            <Loader2 className="w-3 h-3 text-secondary animate-spin" />
          ) : (
            <AlertTriangle className="w-3 h-3 text-warning" />
          )}
        </div>

        <div className="text-[8px] text-muted-foreground/60 font-mono uppercase tracking-[0.15em] mb-3 shrink-0">
          Source · MITRE ATLAS
        </div>

        {incidents.status === "loading" && (
          <div className="font-mono text-[10px] text-muted-foreground flex items-center gap-2 py-3">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading curated case studies…
          </div>
        )}

        {incidents.status === "error" && (
          <div className="font-mono text-[11px] text-warning flex items-center gap-2 py-3">
            <WifiOff className="w-3.5 h-3.5 shrink-0" />
            <span>[ UNAVAILABLE ] case-study feed unreachable</span>
          </div>
        )}

        {incidents.status === "ok" &&
          incidents.data.caseStudies.length === 0 && (
            <div className="font-mono text-[10px] text-muted-foreground italic text-center py-4 opacity-50">
              [ no case studies returned ]
            </div>
          )}

        {incidents.status === "ok" && incidents.data.caseStudies.length > 0 && (
          <div className="flex flex-col gap-1.5 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {incidents.data.caseStudies.map((cs, i) => (
                <motion.a
                  key={cs.id}
                  href={cs.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-case-${cs.id}`}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="group border border-border/30 rounded-sm bg-black/40 hover:border-secondary/50 hover:bg-secondary/5 px-2.5 py-2 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[8px] text-secondary/80 shrink-0">
                      {cs.id}
                    </span>
                    <span className="font-display font-bold text-[10px] text-foreground/90 tracking-wide truncate">
                      {cs.name}
                    </span>
                    <ExternalLink className="w-3 h-3 text-muted-foreground/50 group-hover:text-secondary ml-auto shrink-0 transition-colors" />
                  </div>
                  <p className="font-mono text-[9px] text-muted-foreground leading-relaxed mt-1">
                    {cs.summary}
                  </p>
                </motion.a>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
