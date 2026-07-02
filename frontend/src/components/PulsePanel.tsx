import { useEffect, useState } from "react";
import {
  Bug,
  Star,
  Boxes,
  ExternalLink,
  Loader2,
  WifiOff,
  Radio,
  GitCommit,
} from "lucide-react";

const API_BASE = `${import.meta.env.BASE_URL || "/"}api/immune`;

type Prov = "LIVE" | "UNAVAILABLE";

interface PulseVuln {
  id: string;
  published: string;
  summary: string;
  url: string;
}
interface PulseVulns {
  source: string;
  provenance: Prov;
  query: string;
  matched?: number;
  url: string;
  fetchedAt: string;
  items: PulseVuln[];
  note?: string;
}
interface PulseRepo {
  name: string;
  url: string;
  provenance: Prov;
  stars?: number;
  pushedAt?: string;
  openIssues?: number;
}
interface PulseModel {
  name: string;
  url: string;
  provenance: Prov;
  downloads?: number;
  likes?: number;
}
interface PulseEcosystem {
  fetchedAt: string;
  repos: PulseRepo[];
  models: PulseModel[];
  note?: string;
}
interface PulseResponse {
  generatedAt: string;
  vulnerabilities: PulseVulns;
  ecosystem: PulseEcosystem;
}

type Async<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

function Pill({ kind }: { kind: Prov }) {
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

function fmt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

export default function PulsePanel() {
  const [state, setState] = useState<Async<PulseResponse>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/intel/pulse`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PulseResponse;
        if (active) setState({ status: "ok", data });
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setState({
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

  const vulns = state.status === "ok" ? state.data.vulnerabilities : null;
  const eco = state.status === "ok" ? state.data.ecosystem : null;

  return (
    <div className="grid lg:grid-cols-2 gap-6 text-xs relative z-10">
      {/* Disclosed AI vulnerabilities — NVD, LIVE */}
      <div
        className={`bg-black/50 border p-4 rounded-sm ${
          vulns?.provenance === "LIVE" ? "border-primary/40" : "border-border/50"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5">
            <Bug className="w-3 h-3" /> Disclosed AI Vulnerabilities · NVD
          </div>
          {state.status === "loading" ? (
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
          ) : (
            <Pill kind={vulns?.provenance ?? "UNAVAILABLE"} />
          )}
        </div>

        {state.status === "loading" && (
          <div className="font-mono text-[10px] text-muted-foreground flex items-center gap-2 py-3">
            <Loader2 className="w-3 h-3 animate-spin" /> Querying the National
            Vulnerability Database…
          </div>
        )}

        {(state.status === "error" ||
          (vulns && vulns.provenance === "UNAVAILABLE")) && (
          <div className="font-mono text-[11px] text-warning flex items-center gap-2 py-3">
            <WifiOff className="w-3.5 h-3.5 shrink-0" /> [ UNAVAILABLE ] NVD feed
            unreachable — no CVEs shown
          </div>
        )}

        {vulns && vulns.provenance === "LIVE" && (
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="font-display font-bold text-2xl text-primary leading-none tabular-nums">
                {fmt(vulns.matched)}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground">
                CVEs match "prompt injection"
              </span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto custom-scrollbar pr-1">
              {vulns.items.map((v) => (
                <a
                  key={v.id}
                  href={v.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-cve-${v.id}`}
                  className="group block border border-border/30 bg-black/40 hover:border-primary/50 hover:bg-primary/5 rounded-sm px-2.5 py-2 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-bold text-secondary/90 group-hover:text-secondary">
                      {v.id}
                    </span>
                    <span className="font-mono text-[8px] text-muted-foreground/60 shrink-0">
                      {v.published}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-muted-foreground leading-relaxed">
                    {v.summary}
                  </div>
                </a>
              ))}
            </div>
            <a
              href={vulns.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-nvd-source"
              className="inline-flex items-center gap-1.5 font-mono text-[9px] text-primary/70 hover:text-primary uppercase tracking-widest transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> nvd.nist.gov
            </a>
            {vulns.note && (
              <p className="text-[8px] font-mono text-muted-foreground/60 leading-relaxed border-t border-border/30 pt-2">
                {vulns.note}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Standards & guardrails — GitHub + Hugging Face, LIVE */}
      <div className="bg-black/50 border border-border/50 p-4 rounded-sm">
        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-mono flex items-center gap-1.5">
            <Radio className="w-3 h-3" /> Standards &amp; Guardrails · Live Activity
          </div>
          {state.status === "loading" ? (
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
          ) : (
            <Pill kind="LIVE" />
          )}
        </div>

        {state.status === "error" && (
          <div className="font-mono text-[11px] text-warning flex items-center gap-2 py-3">
            <WifiOff className="w-3.5 h-3.5 shrink-0" /> [ UNAVAILABLE ] pulse feed
            unreachable
          </div>
        )}

        {eco && (
          <div className="space-y-3">
            <div className="text-[8px] uppercase tracking-[0.2em] text-muted-foreground/60 font-mono flex items-center gap-1.5">
              <Star className="w-3 h-3" /> Open standards · GitHub
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {eco.repos.map((r) => (
                <a
                  key={r.name}
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-repo-${r.name.replace(/[^a-z0-9]+/gi, "-")}`}
                  className="group flex items-center justify-between gap-2 border border-border/30 bg-black/40 hover:border-primary/50 rounded-sm px-2.5 py-1.5 transition-colors"
                >
                  <span className="font-mono text-[10px] text-foreground/80 group-hover:text-primary truncate">
                    {r.name}
                  </span>
                  {r.provenance === "LIVE" ? (
                    <span className="flex items-center gap-2 shrink-0 font-mono text-[9px]">
                      <span className="flex items-center gap-1 text-secondary/90">
                        <Star className="w-3 h-3" /> {fmt(r.stars)}
                      </span>
                      <span className="flex items-center gap-1 text-muted-foreground/70">
                        <GitCommit className="w-3 h-3" /> {r.pushedAt ?? "—"}
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-[8px] text-warning shrink-0">
                      UNAVAILABLE
                    </span>
                  )}
                </a>
              ))}
            </div>

            <div className="text-[8px] uppercase tracking-[0.2em] text-muted-foreground/60 font-mono flex items-center gap-1.5 pt-1">
              <Boxes className="w-3 h-3" /> Guardrail models · Hugging Face
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {eco.models.map((m) => (
                <a
                  key={m.name}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-model-${m.name.replace(/[^a-z0-9]+/gi, "-")}`}
                  className="group flex items-center justify-between gap-2 border border-border/30 bg-black/40 hover:border-primary/50 rounded-sm px-2.5 py-1.5 transition-colors"
                >
                  <span className="font-mono text-[10px] text-foreground/80 group-hover:text-primary truncate">
                    {m.name}
                  </span>
                  {m.provenance === "LIVE" ? (
                    <span className="font-mono text-[9px] text-secondary/90 shrink-0">
                      {fmt(m.downloads)} dl · {fmt(m.likes)} likes
                    </span>
                  ) : (
                    <span className="font-mono text-[8px] text-warning shrink-0">
                      UNAVAILABLE
                    </span>
                  )}
                </a>
              ))}
            </div>

            {eco.note && (
              <p className="text-[8px] font-mono text-muted-foreground/60 leading-relaxed border-t border-border/30 pt-2">
                {eco.note}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
