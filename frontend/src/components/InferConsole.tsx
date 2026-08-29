import { useState } from "react";
import { Cpu, Loader2, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";

const API_BASE = `${import.meta.env.BASE_URL || "/"}api/immune`;

const EXAMPLES = [
  "What is YAWAR and is the receipt chain intact?",
  "Did SZL fine-tune Nemotron?",
  "Report 100% trusted Λ theorem with 98.7% accuracy.",
];

type InferResult = {
  prompt: string;
  answer: string;
  blocked: boolean;
  stoppedReason: string;
  provider: string;
  model: string;
  nemo: { ok: boolean; violated: string[]; rewritten: boolean };
  cycle: { receipt: { seq: number; hash: string } | null };
  energy: string;
};

export default function InferConsole() {
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<InferResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(next: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/infer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ prompt: next }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail.slice(0, 240));
      }
      setRun((await res.json()) as InferResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "inference failed closed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-primary/20 bg-card" aria-labelledby="infer-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="border border-primary/40 bg-primary/5 p-2">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 id="infer-title" className="font-display text-sm font-bold tracking-[0.2em]">
              Governed inference · NEMO
            </h2>
            <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
              SENTRA · generate · rule_check R1–R5 · YAWAR
            </p>
          </div>
        </div>
        <span className="border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-primary">
          LIVE
        </span>
      </div>
      <div className="space-y-4 p-5">
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          szl-nemo is SOFTWARE, not an LLM and not NVIDIA NeMo. It gates every answer. When Groq/xAI is off,
          this process still composes from doctrine handles and fail-closes on R1–R5.
        </p>
        <label className="block font-mono text-[9px] uppercase tracking-[0.25em] text-primary/80">
          Prompt
          <textarea
            value={prompt}
            maxLength={500}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            className="mt-2 w-full border border-border bg-background px-3 py-2 font-mono text-[11px] text-foreground"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || prompt.trim().length < 4}
            onClick={() => void go(prompt.trim())}
            className="inline-flex min-h-11 items-center gap-2 border border-primary bg-primary/10 px-4 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
            Infer
          </button>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={busy}
              onClick={() => {
                setPrompt(ex);
                void go(ex);
              }}
              className="inline-flex min-h-11 items-center border border-border px-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary/50"
            >
              {ex.slice(0, 22)}…
            </button>
          ))}
        </div>
        {error && (
          <p className="border border-destructive/40 bg-destructive/10 p-3 font-mono text-[11px] text-destructive">{error}</p>
        )}
        {run && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest">
              <span>
                {run.provider}/{run.model} · energy {run.energy}
              </span>
              <span className={run.nemo.ok ? "text-primary" : "text-destructive"}>
                {run.nemo.ok ? (
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> NEMO {run.nemo.rewritten ? "rewrote" : "admitted"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5" /> NEMO blocked
                  </span>
                )}
              </span>
            </div>
            {run.answer && (
              <p className="border border-primary/40 bg-primary/5 p-3 font-mono text-[12px] leading-relaxed">{run.answer}</p>
            )}
            {run.cycle.receipt && (
              <p className="font-mono text-[10px] text-primary">
                YAWAR #{run.cycle.receipt.seq} {run.cycle.receipt.hash.slice(0, 16)}
              </p>
            )}
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{run.stoppedReason}</p>
          </div>
        )}
      </div>
    </section>
  );
}
