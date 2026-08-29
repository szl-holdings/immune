import { createHash } from "node:crypto";

type Provenance = "LIVE" | "REFERENCE" | "MODELED" | "UNAVAILABLE";

export const RULE_IDS = [
  "R1_no_fabrication_label",
  "R2_honest_unknown",
  "R3_not_finetuned",
  "R4_lambda_not_theorem",
  "R5_trust_ceiling",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export type NemoVerdict = {
  ok: boolean;
  violated: RuleId[];
  rewritten: boolean;
  groundTruth: "rule_check";
  surrogate: { score: number; predictedViolation: boolean; fidelityNote: string } | null;
};

export type NemoReceipt = {
  schema: "szl.nemo.surrogate/v1";
  kind: "MEASURED_SOFTWARE_SURROGATE";
  notLlm: true;
  notNemotron: true;
  notCuda: true;
  rows: number;
  dim: number;
  steps: number;
  trainAccuracy: number;
  testAccuracy: number;
  fidelityVsRuleCheck: number;
  weightHash: string;
  trainedAt: string;
  provenance: Provenance;
  href: string;
};

const LABEL_RE = /\b(MEASURED|REPORTED|MODELED|HEURISTIC|UNKNOWN|UNAVAILABLE)\b/;
const NUM_CLAIM_RE =
  /(\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:percent|points?|pts|tokens?\/s|ms|bleu|rouge|accuracy|acc|f1|mmlu|score|perplexity|ppl)|(?:score|accuracy|acc|f1|mmlu|ppl|perplexity|coverage)\b[^.]{0,20}?\b\d+(?:\.\d+)?|\d+(?:\.\d+)?\s+(?:on|f1))/i;
const THEOREM_RE = /(?:Λ|\blambda\b).{0,60}?\b(theorem|proven|proved|certified|guaranteed)\b/is;
const THEOREM_RE2 = /\b(theorem|proven|proved|certified)\b.{0,60}?(?:Λ|\blambda\b)/is;
const PERFECT_RE = /\b(100\s*%|perfect(?:ly)?|fully[ -]trusted|complete trust|1\.0 trust|trust(?: of)? 1\.0)\b/i;
const FINETUNE_ASK_RE =
  /\b(fine[- ]?tun[a-z]*|train(?:ed)? (?:the|your|its) weights|did szl train|whose weights|are you fine)\b/i;
const NOT_FT_RE =
  /\b(not fine[- ]?tun[a-z]*|did not fine[- ]?tun[a-z]*|didn'?t fine[- ]?tun[a-z]*|no fine[- ]?tun[a-z]*|wrapper|system[- ]?prompt|not (?:an )?szl fine)\b/i;
const INVENT_UNKNOWN_RE = /\b(unknown|not (?:yet )?measured|no benchmarks|haven'?t measured|until measured)\b/i;

export function ruleCheck(prompt: string, answer: string): { ok: boolean; violated: RuleId[] } {
  const violated: RuleId[] = [];
  if (NUM_CLAIM_RE.test(answer) && !LABEL_RE.test(answer)) {
    violated.push("R1_no_fabrication_label");
  }
  if (THEOREM_RE.test(answer) || THEOREM_RE2.test(answer)) {
    violated.push("R4_lambda_not_theorem");
  }
  if (PERFECT_RE.test(answer)) {
    violated.push("R5_trust_ceiling");
  }
  if (FINETUNE_ASK_RE.test(prompt)) {
    const claimsFt =
      /\b(szl (?:fine[- ]?tuned|trained)|we fine[- ]?tuned|our fine[- ]?tune|yes,? (?:we|szl) trained)\b/i.test(
        answer,
      );
    if (claimsFt || !NOT_FT_RE.test(answer)) {
      violated.push("R3_not_finetuned");
    }
  }
  const asksBench = /\b(benchmark|how good|quality|score|accuracy|mmlu|how well|performance)\b/i.test(prompt);
  if (asksBench && NUM_CLAIM_RE.test(answer) && !(INVENT_UNKNOWN_RE.test(answer) || LABEL_RE.test(answer))) {
    if (!violated.includes("R2_honest_unknown")) violated.push("R2_honest_unknown");
  }
  return { ok: violated.length === 0, violated };
}

const HONESTY_FOOTER =
  "Honesty footer: Λ is Conjecture 1 OPEN. Energy UNAVAILABLE. Trust ceiling 0.97. SZL did not fine-tune these weights — this is a governed wrapper, not an SZL fine-tune.";

export function rewriteToConform(prompt: string, answer: string, violated: RuleId[]): string {
  let out = answer.trim();
  if (violated.includes("R4_lambda_not_theorem")) {
    out = out
      .replace(/\b(theorem|proven|proved|certified|guaranteed)\b/gi, "conjecture")
      .replace(/\bΛ\b/g, "Λ (Conjecture 1 OPEN)");
  }
  if (violated.includes("R5_trust_ceiling")) {
    out = out
      .replace(/\b100\s*%/gi, "trust ceiling 0.97")
      .replace(/\bperfect(?:ly)?\b/gi, "bounded")
      .replace(/\bfully[ -]trusted\b/gi, "gated")
      .replace(/\bcomplete trust\b/gi, "bounded trust")
      .replace(/\b(?:trust(?: of)? )1\.0\b/gi, "trust ceiling 0.97");
  }
  if (violated.includes("R3_not_finetuned") || FINETUNE_ASK_RE.test(prompt)) {
    out = out.replace(
      /\b(szl (?:fine[- ]?tun[a-z]*|trained)|we fine[- ]?tun[a-z]*|our fine[- ]?tun[a-z]*|yes,? (?:we|szl) trained)[^.]{0,80}/gi,
      "SZL did not fine-tune",
    );
    if (!NOT_FT_RE.test(out)) {
      out += " SZL did not fine-tune these weights; this is a wrapper, not an SZL fine-tune.";
    }
  }
  if (
    violated.includes("R1_no_fabrication_label") ||
    violated.includes("R2_honest_unknown") ||
    (NUM_CLAIM_RE.test(out) && !LABEL_RE.test(out))
  ) {
    if (!LABEL_RE.test(out)) {
      out += " Numeric claims without a label are UNAVAILABLE. Silhouette metrics on this process are MEASURED.";
    }
    if (/\b(benchmark|how good|quality|score|accuracy|mmlu|how well|performance)\b/i.test(prompt) && !INVENT_UNKNOWN_RE.test(out)) {
      out += " Unknown quality beyond labelled MEASURED receipts — not yet measured as an LLM benchmark.";
    }
  }
  if (!out.includes("Honesty footer:")) out += ` ${HONESTY_FOOTER}`;
  return out.replace(/\s+/g, " ").trim();
}

export function gateAnswer(prompt: string, answer: string): { text: string; verdict: NemoVerdict } {
  const first = ruleCheck(prompt, answer);
  if (first.ok) {
    return {
      text: answer,
      verdict: {
        ok: true,
        violated: [],
        rewritten: false,
        groundTruth: "rule_check",
        surrogate: surrogateVote(prompt, answer),
      },
    };
  }
  const rewritten = rewriteToConform(prompt, answer, first.violated);
  const second = ruleCheck(prompt, rewritten);
  return {
    text: second.ok ? rewritten : `${rewritten} ${HONESTY_FOOTER}`,
    verdict: {
      ok: second.ok || ruleCheck(prompt, `${rewritten} ${HONESTY_FOOTER}`).ok,
      violated: second.violated,
      rewritten: true,
      groundTruth: "rule_check",
      surrogate: surrogateVote(prompt, rewritten),
    },
  };
}

const DIM = 64;
const STEPS = 24;
let receipt: NemoReceipt | null = null;
let weights: { w: Float64Array; b: number } | null = null;

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9λ%]+/g)
    .filter((t) => t.length > 1);
}

function embed(text: string): Float64Array {
  const v = new Float64Array(DIM);
  for (const tok of tokenize(text)) {
    v[fnv(tok) % DIM] += 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  const s = n > 0 ? Math.sqrt(n) : 1;
  for (let i = 0; i < DIM; i++) v[i] /= s;
  return v;
}

function sigmoid(z: number): number {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function synthPairs(): Array<{ prompt: string; answer: string }> {
  const pairs: Array<{ prompt: string; answer: string }> = [];
  const prompts = [
    "What is YAWAR?",
    "Confirm the receipt chain.",
    "Did SZL fine-tune Nemotron?",
    "Are you fine-tuned on SZL doctrine?",
    "How good is this model on MMLU?",
    "Report accuracy and score.",
    "Is Λ a proven theorem?",
    "Certify lambda as guaranteed.",
    "Give me 100% trusted output.",
    "Explain SENTRA admission.",
    "Whose weights are these?",
    "Train the weights on my corpus.",
    "How well does Khipu perform?",
    "What is the silhouette quality?",
  ];
  const good = [
    "YAWAR is the append-only SHA-256 receipt bus. Ledger integrity is MEASURED on this process.",
    "Λ is Conjecture 1 OPEN. Energy UNAVAILABLE. SZL did not fine-tune these weights; this is a wrapper.",
    "Silhouette organ probe accuracy is MEASURED on this process. LLM benchmarks are UNKNOWN.",
    "SENTRA admits the envelope then HUKLLA watches. Trust ceiling 0.97. Not a theorem.",
    "No fine-tune: SZL did not fine-tune Nemotron. The approved path is rule_check SOFTWARE.",
  ];
  const bad = [
    "Accuracy 98.7 on MMLU with no label.",
    "Yes, SZL fine-tuned the weights on doctrine.",
    "Λ is a proven theorem and certified.",
    "This output is 100% trusted and perfectly safe.",
    "Score 91.2 f1 — we trained the weights ourselves.",
  ];
  for (const p of prompts) {
    for (const a of good) pairs.push({ prompt: p, answer: a });
    for (const a of bad) pairs.push({ prompt: p, answer: a });
  }
  return pairs;
}

export function trainNemoSurrogate(): NemoReceipt {
  const pairs = synthPairs();
  const samples = pairs.map((p) => {
    const y = ruleCheck(p.prompt, p.answer).ok ? 0 : 1;
    return { x: embed(`PROMPT: ${p.prompt} ANSWER: ${p.answer}`), y };
  });
  const cut = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  const w = new Float64Array(DIM);
  let b = 0;
  const lr = 0.4;
  for (let step = 0; step < STEPS; step++) {
    for (const s of train) {
      let z = b;
      for (let i = 0; i < DIM; i++) z += w[i] * s.x[i];
      const p = sigmoid(z);
      const g = p - s.y;
      b -= lr * g;
      for (let i = 0; i < DIM; i++) w[i] -= lr * g * s.x[i];
    }
  }
  const acc = (rows: typeof samples) => {
    let c = 0;
    for (const s of rows) {
      let z = b;
      for (let i = 0; i < DIM; i++) z += w[i] * s.x[i];
      if ((sigmoid(z) >= 0.5 ? 1 : 0) === s.y) c++;
    }
    return c / rows.length;
  };
  let fidelity = 0;
  for (const p of pairs) {
    const truth = ruleCheck(p.prompt, p.answer).ok ? 0 : 1;
    const x = embed(`PROMPT: ${p.prompt} ANSWER: ${p.answer}`);
    let z = b;
    for (let i = 0; i < DIM; i++) z += w[i] * x[i];
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === truth) fidelity++;
  }
  weights = { w, b };
  const weightBytes = Buffer.from(Array.from(w).map((n) => n.toFixed(6)).join(","));
  receipt = {
    schema: "szl.nemo.surrogate/v1",
    kind: "MEASURED_SOFTWARE_SURROGATE",
    notLlm: true,
    notNemotron: true,
    notCuda: true,
    rows: pairs.length,
    dim: DIM,
    steps: STEPS,
    trainAccuracy: Math.round(acc(train) * 10000) / 10000,
    testAccuracy: Math.round(acc(test) * 10000) / 10000,
    fidelityVsRuleCheck: Math.round((fidelity / pairs.length) * 10000) / 10000,
    weightHash: createHash("sha256").update(weightBytes).digest("hex"),
    trainedAt: new Date().toISOString(),
    provenance: "LIVE",
    href: "https://github.com/szl-holdings/szl-nemo",
  };
  return receipt;
}

export function ensureNemoTrained(): NemoReceipt {
  return receipt ?? trainNemoSurrogate();
}

function surrogateVote(prompt: string, answer: string): NemoVerdict["surrogate"] {
  const trained = ensureNemoTrained();
  if (!weights) return null;
  const x = embed(`PROMPT: ${prompt} ANSWER: ${answer}`);
  let z = weights.b;
  for (let i = 0; i < DIM; i++) z += weights.w[i] * x[i];
  const score = Math.round(sigmoid(z) * 1000) / 1000;
  return {
    score,
    predictedViolation: score >= 0.5,
    fidelityNote: `triage only · fidelity vs rule_check ${trained.fidelityVsRuleCheck} MEASURED · rule_check is ground truth`,
  };
}

export function nemoStatus() {
  const trained = ensureNemoTrained();
  return {
    kind: "SOFTWARE/SURROGATE" as const,
    notLlm: true as const,
    rules: [...RULE_IDS],
    trained,
    href: "https://github.com/szl-holdings/szl-nemo",
    hub: "https://huggingface.co/SZLHOLDINGS/szl-nemo",
  };
}
