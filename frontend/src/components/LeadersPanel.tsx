import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Award, ExternalLink, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";

interface LeaderMember {
  name: string;
  what: string;
  url: string;
}

interface LeaderCategory {
  category: string;
  members: LeaderMember[];
}

interface LeadersResponse {
  generatedAt: string;
  categories: LeaderCategory[];
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: LeadersResponse }
  | { status: "error" };

const FRAMING =
  "IMMUNE implements the same verifiable-AI principles these leaders pioneered — open standards (Sigstore/Rekor, SLSA), hardware attestation (NVIDIA/Intel/AMD), and adversarial-ML frameworks (MITRE ATLAS, OWASP).";

export default function LeadersPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.BASE_URL || "/";
    const url = `${base}api/immune/intel/leaders`;

    (async () => {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as LeadersResponse;
        if (!cancelled) {
          if (json && Array.isArray(json.categories)) {
            setState({ status: "ready", data: json });
          } else {
            setState({ status: "error" });
          }
        }
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4 text-xs h-full overflow-y-auto pr-2 custom-scrollbar relative z-10">
      {/* Header */}
      <div className="bg-black/50 border border-border/50 p-3 rounded-sm">
        <div className="text-[9px] uppercase tracking-[0.2em] text-secondary/80 font-mono flex items-center gap-1.5 border-b border-border/50 pb-2 mb-3">
          <Award className="w-3 h-3" /> Aligned With The Field
        </div>
        <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
          {FRAMING}
        </p>
        <div className="mt-3 flex items-center gap-1.5 text-[9px] font-mono text-primary/70 uppercase tracking-widest">
          <ShieldCheck className="w-3 h-3" /> Same principles · independently verifiable
        </div>
      </div>

      {/* Loading */}
      {state.status === "loading" && (
        <div className="bg-black/50 border border-border/50 p-6 rounded-sm flex items-center justify-center gap-2 font-mono text-[10px] text-primary/70">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading leader registry…
        </div>
      )}

      {/* Error / unavailable — honest, no fabricated content */}
      {state.status === "error" && (
        <div className="bg-black/50 border border-warning/50 p-4 rounded-sm">
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-warning uppercase tracking-widest">
            <AlertTriangle className="w-3 h-3" /> Registry feed unavailable
          </div>
          <p className="mt-2 text-[9px] font-mono text-muted-foreground leading-relaxed">
            The /intel/leaders feed could not be reached. Nothing is shown rather than fabricated.
          </p>
        </div>
      )}

      {/* Ready */}
      {state.status === "ready" &&
        state.data.categories.map((cat, ci) => (
          <motion.div
            key={cat.category}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: ci * 0.05 }}
            className="bg-black/50 border border-border/50 p-3 rounded-sm"
          >
            <div className="text-[9px] uppercase tracking-[0.2em] text-primary/80 font-mono border-b border-border/50 pb-2 mb-3">
              {cat.category}
            </div>
            <div className="grid grid-cols-1 gap-2">
              {cat.members.map((m) => (
                <a
                  key={m.name}
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`link-leader-${m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  className="group block border border-border/30 bg-black/40 hover:border-primary/50 hover:bg-primary/5 rounded-sm px-2.5 py-2 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-bold text-[11px] tracking-wider text-foreground group-hover:text-primary transition-colors">
                      {m.name}
                    </span>
                    <ExternalLink className="w-3 h-3 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-muted-foreground leading-relaxed">
                    {m.what}
                  </div>
                </a>
              ))}
            </div>
          </motion.div>
        ))}

      {state.status === "ready" && state.data.generatedAt && (
        <div className="text-[8px] font-mono text-muted-foreground/50 uppercase tracking-widest text-right">
          Registry · {state.data.generatedAt.slice(0, 10)}
        </div>
      )}
    </div>
  );
}
