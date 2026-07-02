import { motion } from "framer-motion";
import {
  Sigma,
  ExternalLink,
  BadgeCheck,
  FlaskConical,
  AlertTriangle,
} from "lucide-react";
import type { ReactNode } from "react";

const GH = "https://github.com/szl-holdings";

// Maturity is the honesty spine of this panel: we NEVER call a conjecture a
// theorem. PROVEN = machine-checked in Lean; CONJECTURE = advisory, explicitly
// unproven; METHOD = a real engineering/measurement recipe, not a proof.
type Maturity = "PROVEN" | "CONJECTURE" | "METHOD";

const MATURITY: Record<
  Maturity,
  { label: string; blurb: string; cls: string; Icon: typeof BadgeCheck }
> = {
  PROVEN: {
    label: "PROVEN",
    blurb: "machine-checked in Lean 4 (zero-sorry)",
    cls: "border-primary/50 text-primary bg-primary/10",
    Icon: BadgeCheck,
  },
  CONJECTURE: {
    label: "CONJECTURE",
    blurb: "advisory — explicitly NOT a proven theorem",
    cls: "border-warning/50 text-warning bg-warning/10",
    Icon: AlertTriangle,
  },
  METHOD: {
    label: "METHOD",
    blurb: "measured/engineering recipe — not a proof",
    cls: "border-secondary/50 text-secondary bg-secondary/10",
    Icon: FlaskConical,
  },
};

interface Foundation {
  id: string;
  title: string;
  subtitle: string;
  maturity: Maturity;
  repo: string;
  formula: ReactNode;
  where?: ReactNode;
  note: string;
}

// Every entry below is transcribed VERBATIM from its canonical szl-holdings
// repository (linked). Nothing here is invented — this is the "canonical corpus"
// the served surfaces must match.
const FOUNDATIONS: Foundation[] = [
  {
    id: "lambda",
    title: "Λ — Governance aggregator",
    subtitle: "Λ (Lambda-Spine): weighted geometric mean of axis scores",
    maturity: "CONJECTURE",
    repo: "szl-lambda-gate",
    formula: (
      <>
        Λ(x) ={" "}
        <span className="text-primary">
          ∏<sub className="text-[0.6em]">i</sub>
        </span>{" "}
        x<sub className="text-[0.6em]">i</sub>
        <sup className="text-[0.65em]">
          w<sub className="text-[0.7em]">i</sub>
        </sup>
      </>
    ),
    where: (
      <>
        ∑<sub className="text-[0.6em]">i</sub> w
        <sub className="text-[0.6em]">i</sub> = 1 &nbsp;·&nbsp; w
        <sub className="text-[0.6em]">i</sub> &gt; 0 &nbsp;·&nbsp; x
        <sub className="text-[0.6em]">i</sub> ∈ [0,1]
      </>
    ),
    note: "Non-compensatory: any single zeroed or non-finite axis drives the whole aggregate to exactly 0. Λ is Conjecture 1 — advisory, not proven trust, never 100%.",
  },
  {
    id: "axioms",
    title: "Λ carried axioms (A1–A4)",
    subtitle: "Real runtime self-checks on every aggregation",
    maturity: "METHOD",
    repo: "szl-lambda-gate",
    formula: (
      <div className="flex flex-col gap-1 text-left text-sm sm:text-base">
        <span>
          <span className="text-primary">A1</span> monotone — Λ non-decreasing in
          each axis
        </span>
        <span>
          <span className="text-primary">A2</span> homogeneous — Λ(t·x) = t·Λ(x)
        </span>
        <span>
          <span className="text-primary">A3</span> Egyptian-exact — Λ(c,…,c) = c
        </span>
        <span>
          <span className="text-primary">A4</span> bounded — Λ(x) ≤ max
          <sub className="text-[0.6em]">i</sub> x
          <sub className="text-[0.6em]">i</sub>
        </span>
      </div>
    ),
    note: "Checked empirically on sampled inputs at runtime (selfcheck) — NOT a proof of Λ-uniqueness.",
  },
  {
    id: "lutar",
    title: "Lutar invariant — locked axiom count",
    subtitle: "The size of the locked set is itself a Lean theorem",
    maturity: "PROVEN",
    repo: "lutar-lean",
    formula: (
      <>
        ⊢ locked_count_eight :{" "}
        <span className="text-primary">|locked| = 8</span>
      </>
    ),
    where: <>Lean-core axioms only: [propext, Classical.choice, Quot.sound]</>,
    note: "A zero-axiom Lean theorem: the locked axiom set cannot silently grow. ~100 kernel-clean theorems across the waves; Λ itself stays Conjecture 1.",
  },
  {
    id: "norm",
    title: "Governed normalization",
    subtitle: "RMSNorm reference + SHA3-256 hash-chained receipts",
    maturity: "PROVEN",
    repo: "szl-governed-norm",
    formula: (
      <>
        RMSNorm(x) = w ⊙{" "}
        <span className="inline-flex flex-col items-center align-middle mx-1">
          <span className="border-b border-current px-2 leading-tight">x</span>
          <span className="leading-tight text-[0.8em]">
            √( mean(x<sup className="text-[0.7em]">2</sup>) + ε )
          </span>
        </span>
      </>
    ),
    note: "Computed in float32 for numerical stability, verified against PyTorch's own reference. Governed mode emits content-addressed, hash-chained receipts of each call.",
  },
  {
    id: "khipu",
    title: "Khipu consensus quorum",
    subtitle: "BFT multi-party witnessed agreement",
    maturity: "METHOD",
    repo: "khipu-consensus",
    formula: (
      <>
        tally(≥ 3 / 4) &nbsp;⟸&nbsp;{" "}
        <span className="text-primary">n ≥ 3f + 1</span>
      </>
    ),
    where: <>n = 4, threshold = 3, tolerates f = 1 faulty / Byzantine witness</>,
    note: "Each witness DSSE-signs ECDSA-P256(PAE(...)) over canonical JSON. Decidable counting — a sibling of Λ, tracked, not a theorem.",
  },
  {
    id: "energy",
    title: "Energy attestation",
    subtitle: "Measured joules — or an honest UNAVAILABLE",
    maturity: "METHOD",
    repo: "governed-inference-meter",
    formula: (
      <>
        tokens/joule ={" "}
        <span className="inline-flex flex-col items-center align-middle mx-1">
          <span className="border-b border-current px-2 leading-tight">
            tokens
          </span>
          <span className="leading-tight">joules</span>
        </span>
      </>
    ),
    where: <>joules = ∫ power dt over wall-time (real NVML)</>,
    note: "MEASURED from real NVML, or mode=unmeasured with joules = null. We never fabricate a joule figure.",
  },
];

function FoundationCard({ f, index }: { f: Foundation; index: number }) {
  const m = MATURITY[f.maturity];
  const MIcon = m.Icon;
  return (
    <motion.a
      href={`${GH}/${f.repo}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`card-formula-${f.id}`}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ delay: index * 0.06, type: "spring", stiffness: 200, damping: 24 }}
      className="group flex flex-col gap-3 rounded-sm border border-border/50 bg-black/40 p-4 sm:p-5 hover:border-primary/50 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-display font-bold text-sm sm:text-base tracking-wide text-foreground leading-tight">
            {f.title}
          </h4>
          <p className="font-mono text-[10px] sm:text-[11px] text-muted-foreground mt-1 leading-snug">
            {f.subtitle}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 shrink-0 rounded-sm border px-1.5 py-1 font-mono text-[9px] sm:text-[10px] uppercase tracking-widest ${m.cls}`}
          title={m.blurb}
        >
          <MIcon className="w-3 h-3" />
          {m.label}
        </span>
      </div>

      {/* The formula itself — the canonical corpus, rendered honestly */}
      <div className="rounded-sm border border-primary/15 bg-black/50 px-3 py-4 text-center">
        <div className="font-mono text-lg sm:text-xl text-foreground break-words">
          {f.formula}
        </div>
        {f.where && (
          <div className="font-mono text-[11px] sm:text-xs text-primary/60 mt-2 break-words">
            {f.where}
          </div>
        )}
      </div>

      <p className="font-mono text-[10px] sm:text-[11px] text-muted-foreground/80 leading-relaxed">
        {f.note}
      </p>

      <div className="mt-auto flex items-center gap-1.5 font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.2em] text-secondary/70 group-hover:text-secondary transition-colors">
        <ExternalLink className="w-3 h-3" />
        szl-holdings/{f.repo}
        <span className="ml-1 rounded-sm border border-secondary/30 px-1 py-px text-secondary/80">
          REFERENCE
        </span>
      </div>
    </motion.a>
  );
}

export default function FoundationsPanel() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-primary/70">
          <Sigma className="w-3.5 h-3.5" />
          Mathematical Foundations · The Canonical Corpus
        </div>
        <h3 className="text-xl sm:text-2xl md:text-3xl font-display font-bold tracking-widest">
          THE MATH UNDERNEATH — AND WHAT IT DOES / DOESN'T PROVE
        </h3>
        <p className="font-mono text-[11px] text-muted-foreground leading-relaxed max-w-3xl">
          IMMUNE's guarantees rest on a public, versioned body of math. Every formula
          below is transcribed verbatim from its open-source kernel and links to that
          source. Each carries an honest maturity label — because the fastest way to
          lose an investor's trust is to call a conjecture a theorem.
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(MATURITY) as Maturity[]).map((k) => {
            const m = MATURITY[k];
            const MIcon = m.Icon;
            return (
              <span
                key={k}
                className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[9px] sm:text-[10px] uppercase tracking-wider ${m.cls}`}
              >
                <MIcon className="w-3 h-3" />
                {m.label}
                <span className="normal-case tracking-normal text-muted-foreground/70">
                  — {m.blurb}
                </span>
              </span>
            );
          })}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {FOUNDATIONS.map((f, i) => (
          <FoundationCard key={f.id} f={f} index={i} />
        ))}
      </div>

      <p className="font-mono text-[10px] text-muted-foreground/60 leading-relaxed border-t border-border/40 pt-4">
        Sources are the SZL Holdings open kernels on GitHub (Apache-2.0 code · CC-BY-4.0
        papers). A served formula that does not exist in this canonical corpus is a bug,
        not a feature — the honesty doctrine treats overclaiming as a failure.
      </p>
    </div>
  );
}
