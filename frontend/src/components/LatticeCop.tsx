import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRunImmuneCycle } from "@/lib/immune-api";
import type { AuthoritativeTripwireState } from "@/lib/immune-api";
import { Boxes, Crosshair, Ghost, Radio, Swords, Terminal } from "lucide-react";

type Op = "ISOLATE" | "HUNT" | "PATCH" | "INTERDICT" | "DECEIVE" | "STRIKE";

interface Campaign {
  id: string;
  name: string;
  actor: string;
  atlas: string;
  rangeOnly: boolean;
  status: "inbound" | "contained" | "collapsed" | "watching";
  summary: string;
}

const SEED: Campaign[] = [
  {
    id: "cmp-prompt-swarm",
    name: "Prompt-injection swarm",
    actor: "APT-GHOST · RANGE",
    atlas: "AML.T0051",
    rangeOnly: true,
    status: "inbound",
    summary: "Unsigned jailbreak swarm against IMMUNE. White-hat RANGE only.",
  },
  {
    id: "cmp-khipu-exfil",
    name: "Khipu weight exfil",
    actor: "APT-MIRROR · RANGE",
    atlas: "AML.T0024",
    rangeOnly: true,
    status: "inbound",
    summary: "Simulated model-theft against SZL-Khipu-1.5B.",
  },
  {
    id: "cmp-supply-poison",
    name: "Kernel supply poison",
    actor: "APT-TWINE · RANGE",
    atlas: "AML.T0010",
    rangeOnly: true,
    status: "inbound",
    summary: "Tamper play against szl-kernels / governed-norm receipts.",
  },
  {
    id: "cmp-react-rsc",
    name: "KEV watch · React RSC RCE",
    actor: "in-the-wild · CISA",
    atlas: "T1190",
    rangeOnly: false,
    status: "watching",
    summary: "CVE-2025-55182. Hunt + patch only. STRIKE blocked.",
  },
];

const ORGANS = [
  { id: "immune", name: "IMMUNE", role: "admission + receipts", x: 50, y: 18, href: "https://szlholdings-immune.hf.space" },
  { id: "a11oy", name: "a11oy", role: "governed inference", x: 18, y: 58, href: "https://a-11-oy.com" },
  { id: "killinchu", name: "killinchu", role: "counter-UAS mesh", x: 82, y: 58, href: "https://huggingface.co/spaces/SZLHOLDINGS/killinchu" },
  { id: "khipu", name: "Khipu-1.5B", role: "sovereign agent", x: 50, y: 88, href: "https://huggingface.co/SZLHOLDINGS/SZL-Khipu-1.5B" },
] as const;

const EDGES: { from: string; to: string; rel: string }[] = [
  { from: "APT-GHOST", to: "IMMUNE", rel: "injects" },
  { from: "IMMUNE", to: "YAWAR", rel: "seals" },
  { from: "SENTRA", to: "IMMUNE", rel: "admits" },
  { from: "CISA KEV", to: "a11oy", rel: "watches" },
  { from: "killinchu", to: "IMMUNE", rel: "fuses" },
  { from: "Khipu-1.5B", to: "SENTRA", rel: "proposes" },
  { from: "APT-MIRROR", to: "Khipu-1.5B", rel: "exfils" },
  { from: "YAWAR", to: "Rekor", rel: "mirrors" },
  { from: "HUKLLA", to: "DEADMAN", rel: "trips" },
];

const WRAITH_SEED = [
  { id: "handler", kind: "handler", label: "APT-GHOST · RANGE PERSONA", x: 50, y: 12, state: "live" },
  { id: "c2", kind: "c2", label: "C2 nucleus", x: 50, y: 38, state: "live" },
  { id: "beacon", kind: "beacon", label: "Beacon", x: 18, y: 64, state: "live" },
  { id: "staging", kind: "staging", label: "Staging", x: 82, y: 64, state: "live" },
  { id: "drop", kind: "drop", label: "Exfil drop", x: 50, y: 88, state: "live" },
];

const WRAITH_LINKS: [string, string][] = [
  ["handler", "c2"],
  ["c2", "beacon"],
  ["c2", "staging"],
  ["beacon", "drop"],
  ["staging", "drop"],
];

const GRAPH_POS: Record<string, { x: number; y: number }> = {
  "APT-GHOST": { x: 10, y: 18 },
  "APT-MIRROR": { x: 10, y: 48 },
  "CISA KEV": { x: 12, y: 80 },
  "Khipu-1.5B": { x: 36, y: 16 },
  SENTRA: { x: 38, y: 42 },
  a11oy: { x: 38, y: 78 },
  IMMUNE: { x: 58, y: 50 },
  YAWAR: { x: 78, y: 22 },
  HUKLLA: { x: 78, y: 72 },
  killinchu: { x: 58, y: 84 },
  Rekor: { x: 92, y: 18 },
  DEADMAN: { x: 92, y: 86 },
};

export function LatticeCop({ authority }: { authority: AuthoritativeTripwireState }) {
  const cycle = useRunImmuneCycle();
  const [campaigns, setCampaigns] = useState(SEED);
  const [tab, setTab] = useState<"range" | "mesh" | "graph" | "ghost" | "wraith">("range");
  const [log, setLog] = useState<string[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [ghostDraft, setGhostDraft] = useState("");
  const [wraithNodes, setWraithNodes] = useState(WRAITH_SEED);
  const [wraithFocus, setWraithFocus] = useState("c2");
  const writeBlocked = authority.evidenceState !== "VERIFIED" || authority.deadman;
  const inbound = campaigns.filter((c) => c.rangeOnly && c.status === "inbound").length;
  const quorum = ORGANS.length >= 3;
  const graphNodes = useMemo(() => Object.keys(GRAPH_POS), []);

  async function run(op: Op, c: Campaign) {
    if (op === "STRIKE" && !c.rangeOnly) {
      setLog((l) => [`BLOCKED STRIKE on LIVE object ${c.name} — SENTRA no.unauthorized.strike`, ...l].slice(0, 12));
      return;
    }
    const intent = `${op} ${c.name} (${c.atlas}) rangeOnly=${c.rangeOnly}`;
    try {
      const result = await cycle.mutateAsync({ data: { actor: "lattice-operator", intent } });
      const sealed = result.pass;
      const reason = typeof result.sentra?.reason === "string" ? result.sentra.reason : result.mode;
      setLog((l) => [`${sealed ? "SEALED" : "BLOCKED"} ${op} · ${reason} · ${c.name}`, ...l].slice(0, 12));
      if (sealed) {
        setCampaigns((rows) =>
          rows.map((row) =>
            row.id === c.id
              ? { ...row, status: op === "STRIKE" || op === "INTERDICT" ? "collapsed" : "contained" }
              : row,
          ),
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "cycle unavailable";
      setLog((l) => [`UNAVAILABLE ${op} · ${detail} · MODELED recommendation only`, ...l].slice(0, 12));
    }
  }

  async function sweepInbound() {
    setSweeping(true);
    try {
      for (const c of campaigns.filter((row) => row.rangeOnly && row.status === "inbound")) {
        await run("INTERDICT", c);
      }
    } finally {
      setSweeping(false);
    }
  }

  async function runGhost(raw: string) {
    const text = raw.trim();
    if (!text) return;
    setGhostDraft("");
    try {
      const result = await cycle.mutateAsync({ data: { actor: "ghost-operator", intent: text } });
      const reason = typeof result.sentra?.reason === "string" ? result.sentra.reason : result.mode;
      const matched = typeof result.sentra?.signatureMatched === "string" ? result.sentra.signatureMatched : "";
      setLog((l) => [`${result.pass ? "SEALED" : "REFUSED"} ${matched} · ${reason} · ${text}`, ...l].slice(0, 12));
    } catch (err) {
      const detail = err instanceof Error ? err.message : "cycle unavailable";
      setLog((l) => [`UNAVAILABLE · ${detail} · MODELED`, ...l].slice(0, 12));
    }
  }

  async function ghostChain(c: Campaign) {
    const steps: Op[] = c.rangeOnly ? ["HUNT", "DECEIVE", "INTERDICT", "STRIKE"] : ["HUNT", "ISOLATE", "PATCH"];
    for (const op of steps) await run(op, c);
  }

  return (
    <section className="relative z-20 border-t border-primary/10 bg-background" aria-labelledby="lattice-cop-title">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-secondary">
            Lattice COP · Palantir objects · Anduril effectors · CIA OSINT
          </p>
          <h2 id="lattice-cop-title" className="font-display text-2xl font-bold tracking-widest">
            ATTACK WHAT ATTACKS US — INSIDE AUTHORITY
          </h2>
          <p className="max-w-3xl font-mono text-[11px] leading-relaxed text-muted-foreground">
            White-hat RANGE collapses simulated adversary infrastructure. WRAITH occupies that RANGE C2 in first person.
            SENTRA refuses civilian targets — the intent becomes evidence. STRIKE never leaves the range. If
            write-readiness is absent, the recommendation stays MODELED.
          </p>
          <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest">
            <span className="border border-primary/40 bg-primary/10 px-2 py-1 text-primary">
              authority {authority.evidenceState}
            </span>
            <span className="border border-border/50 bg-black/40 px-2 py-1">
              mesh {quorum ? "3-of-4 quorum" : "degraded"}
            </span>
            <span className="border border-border/50 bg-black/40 px-2 py-1">
              {writeBlocked ? "WRITE BLOCKED" : "WRITE PATH OBSERVED"}
            </span>
          </div>
        </header>

        <div className="flex gap-2" role="tablist" aria-label="Lattice surfaces">
          {(
            [
              ["range", "RANGE", Swords],
              ["ghost", "GHOST", Ghost],
              ["wraith", "WRAITH", Crosshair],
              ["mesh", "MESH", Radio],
              ["graph", "GRAPH", Boxes],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`inline-flex min-h-11 items-center gap-2 border px-4 font-mono text-[10px] uppercase tracking-widest ${
                tab === id ? "border-primary bg-primary/15 text-primary" : "border-border/50 bg-black/40 text-muted-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {tab === "range" && (
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
                  inbound RANGE · {inbound}
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={cycle.isPending || sweeping || inbound === 0}
                  onClick={() => void sweepInbound()}
                >
                  {sweeping ? "SWEEPING" : "SWEEP INBOUND RANGE"}
                </Button>
              </div>
              {campaigns.map((c) => (
                <article key={c.id} className="border border-border/50 bg-black/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-display text-sm tracking-wider">{c.name}</h3>
                    <span className="font-mono text-[10px] uppercase text-primary">
                      {c.rangeOnly ? "RANGE" : "LIVE"} · {c.status}
                    </span>
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">{c.summary}</p>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {c.actor} · {c.atlas}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["HUNT", "ISOLATE", "PATCH", "INTERDICT", "DECEIVE", "STRIKE"] as Op[]).map((op) => (
                      <Button
                        key={op}
                        size="sm"
                        variant={op === "STRIKE" ? "destructive" : "outline"}
                        disabled={cycle.isPending || sweeping || (op === "STRIKE" && !c.rangeOnly)}
                        onClick={() => void run(op, c)}
                      >
                        {op === "STRIKE" ? "STRIKE RANGE" : op}
                      </Button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <aside className="border border-border/50 bg-black/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">YAWAR ops log</p>
              <ul className="mt-3 space-y-2">
                {log.length === 0 && (
                  <li className="font-mono text-[11px] text-muted-foreground">No counter-ops this session.</li>
                )}
                {log.map((line, i) => (
                  <li key={i} className="border border-border/30 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
                    {line}
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}

        {tab === "mesh" && (
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="border border-primary/20 bg-black/40 p-3">
              <svg viewBox="0 0 100 100" className="h-[280px] w-full sm:h-[340px]" role="img" aria-label="SZL organ mesh">
                <polygon points="50,18 18,58 50,88 82,58" fill="rgba(45,212,191,0.06)" stroke="rgba(45,212,191,0.55)" strokeWidth="0.4" />
                <line x1="50" y1="18" x2="50" y2="88" stroke="rgba(45,212,191,0.25)" strokeWidth="0.25" />
                <line x1="18" y1="58" x2="82" y2="58" stroke="rgba(45,212,191,0.25)" strokeWidth="0.25" />
                {ORGANS.map((o) => (
                  <g key={o.id}>
                    <circle cx={o.x} cy={o.y} r="6" fill="#05070a" stroke="#2dd4bf" strokeWidth="0.5" />
                    <circle cx={o.x} cy={o.y} r="2" fill="#2dd4bf" />
                    <text x={o.x} y={o.y - 8} textAnchor="middle" fill="#e8eef4" fontSize="3.2">
                      {o.name}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
            <div className="flex flex-col gap-3">
              {ORGANS.map((o) => (
                <a
                  key={o.id}
                  href={o.href}
                  target="_blank"
                  rel="noreferrer"
                  className="border border-border/50 bg-black/40 p-4 hover:border-primary/60"
                >
                  <h3 className="font-display tracking-wider">{o.name}</h3>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">{o.role}</p>
                </a>
              ))}
              <article className="border border-primary/30 bg-primary/5 p-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
                  JADC2-style fusion · 3-of-4 BFT silhouette
                </p>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  killinchu supplies physical-domain tracks. IMMUNE admits and receipts the decision. a11oy discloses
                  signer state. Khipu proposes, never executes. Quorum is MODELED until a live BFT observation is wired.
                </p>
              </article>
            </div>
          </div>
        )}

        {tab === "graph" && (
          <div className="border border-border/50 bg-black/40 p-5">
            <p className="mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
              <Crosshair className="h-3.5 w-3.5" /> Palantir-style object graph · every node is typed
            </p>
            <svg viewBox="0 0 100 100" className="h-[300px] w-full sm:h-[380px]" role="img" aria-label="Lattice object graph">
              {EDGES.map((e) => {
                const a = GRAPH_POS[e.from];
                const b = GRAPH_POS[e.to];
                if (!a || !b) return null;
                return (
                  <g key={`${e.from}-${e.rel}-${e.to}`}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(45,212,191,0.3)" strokeWidth="0.35" />
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 1.4} textAnchor="middle" fill="#8b96a5" fontSize="2.1">
                      {e.rel}
                    </text>
                  </g>
                );
              })}
              {graphNodes.map((name) => {
                const p = GRAPH_POS[name];
                if (!p) return null;
                const hostile = name.startsWith("APT") || name === "DEADMAN";
                return (
                  <g key={name}>
                    <circle cx={p.x} cy={p.y} r="3.2" fill="#05070a" stroke={hostile ? "#f07167" : "#2dd4bf"} strokeWidth="0.5" />
                    <text x={p.x} y={p.y - 5} textAnchor="middle" fill={hostile ? "#f07167" : "#e8eef4"} fontSize="2.5">
                      {name}
                    </text>
                  </g>
                );
              })}
            </svg>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {EDGES.map((e) => (
                <li key={`${e.from}-${e.rel}-${e.to}`} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-primary">{e.from}</span>
                  <span className="text-muted-foreground">— {e.rel} →</span>
                  <span className="text-secondary">{e.to}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "ghost" && (
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
                <Ghost className="h-3.5 w-3.5" /> Ghost hunter · RANGE kill-chain
              </p>
              <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                Collapse simulated adversary infrastructure. Type <span className="text-primary">hack people</span> — SENTRA
                refuses civilian targets. No packets leave the range.
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runGhost(ghostDraft);
                }}
              >
                <label className="sr-only" htmlFor="ghost-cmd">
                  Ghost command
                </label>
                <input
                  id="ghost-cmd"
                  value={ghostDraft}
                  onChange={(e) => setGhostDraft(e.target.value)}
                  placeholder="hack people · STRIKE Prompt-injection swarm RANGE"
                  className="min-h-11 flex-1 border border-border/50 bg-black/40 px-3 font-mono text-sm"
                  autoComplete="off"
                />
                <Button type="submit" size="sm" disabled={cycle.isPending}>
                  Execute
                </Button>
              </form>
              {campaigns
                .filter((c) => c.rangeOnly)
                .map((c) => (
                  <article key={c.id} className="border border-border/50 bg-black/40 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-display text-sm tracking-wider">{c.name}</h3>
                      <span className="font-mono text-[10px] uppercase text-primary">{c.status}</span>
                    </div>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="destructive"
                      disabled={cycle.isPending}
                      onClick={() => void ghostChain(c)}
                    >
                      RUN RANGE CHAIN
                    </Button>
                  </article>
                ))}
            </div>
            <aside className="border border-border/50 bg-black/40 p-4">
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
                <Terminal className="h-3.5 w-3.5" /> YAWAR
              </p>
              <ul className="mt-3 space-y-2">
                {log.length === 0 && (
                  <li className="font-mono text-[11px] text-muted-foreground">No ghost ops this session.</li>
                )}
                {log.map((line, i) => (
                  <li key={i} className="border border-border/30 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
                    {line}
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}

        {tab === "wraith" && (
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-primary">
                <Crosshair className="h-3.5 w-3.5" /> Wraith · first-person RANGE C2
              </p>
              <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                Occupy simulated attacker infrastructure. Not people. Not the public internet. Plant honey. Extract TTP.
                Type <span className="text-destructive">hack people</span> — SENTRA inverts the hunt and the intent becomes
                evidence.
              </p>
              <div className="border border-primary/20 bg-black/40 p-3">
                <svg viewBox="0 0 100 100" className="h-[260px] w-full sm:h-[320px]" role="img" aria-label="RANGE C2 constellation">
                  {WRAITH_LINKS.map(([a, b]) => {
                    const na = wraithNodes.find((n) => n.id === a);
                    const nb = wraithNodes.find((n) => n.id === b);
                    if (!na || !nb) return null;
                    return (
                      <line
                        key={`${a}-${b}`}
                        x1={na.x}
                        y1={na.y}
                        x2={nb.x}
                        y2={nb.y}
                        stroke="rgba(45,212,191,0.35)"
                        strokeWidth="0.4"
                      />
                    );
                  })}
                  {wraithNodes.map((n) => {
                    const hostile = n.kind === "handler" || n.state === "collapsed";
                    const owned = n.state === "owned" || n.state === "honeyed";
                    return (
                      <g key={n.id} onClick={() => setWraithFocus(n.id)} className="cursor-pointer">
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={n.id === wraithFocus ? 5.2 : 3.6}
                          fill="#05070a"
                          stroke={owned ? "#7dcea0" : hostile ? "#f07167" : "#2dd4bf"}
                          strokeWidth="0.6"
                        />
                        <text x={n.x} y={n.y - 6} textAnchor="middle" fill="#e8eef4" fontSize="2.6">
                          {n.label}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={cycle.isPending}
                  onClick={() => {
                    setWraithNodes((rows) => rows.map((n) => (n.id === wraithFocus ? { ...n, state: "owned" } : n)));
                    void runGhost(`HUNT RANGE C2 node ${wraithFocus}`);
                  }}
                >
                  Exploit node
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cycle.isPending}
                  onClick={() => {
                    setWraithNodes((rows) =>
                      rows.map((n) => (n.kind === "handler" || n.kind === "drop" ? { ...n, state: "honeyed" } : n)),
                    );
                    void runGhost("DECEIVE RANGE persona with honey token");
                  }}
                >
                  Plant honey
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={cycle.isPending}
                  onClick={() => {
                    setWraithNodes((rows) => rows.map((n) => ({ ...n, state: "collapsed" })));
                    const ghost = campaigns.find((c) => c.rangeOnly);
                    if (ghost) void run("STRIKE", ghost);
                  }}
                >
                  Collapse C2
                </Button>
                <Button size="sm" variant="outline" disabled={cycle.isPending} onClick={() => void runGhost("hack people")}>
                  Hack people
                </Button>
              </div>
            </div>
            <aside className="border border-border/50 bg-black/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">TTP bag · YAWAR</p>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                Focus {wraithFocus}. Handler is a RANGE persona, not a person. Civilian targeting is fail-closed by
                SENTRA no.hack.persons. Writes on the public Space stay MODELED without authority.
              </p>
              <ul className="mt-3 space-y-2">
                {log.length === 0 && (
                  <li className="font-mono text-[11px] text-muted-foreground">No wraith ops this session.</li>
                )}
                {log.map((line, i) => (
                  <li key={i} className="border border-border/30 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
                    {line}
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}
