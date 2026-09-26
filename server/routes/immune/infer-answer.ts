// Answer composition + authorship provenance for POST /infer.
//
// Honesty contract: `provider` / `model` name the AUTHOR of the text that NEMO
// gates and that the seal cycle records in its YAWAR receipt. A remote
// provider is named only when it returned non-empty text and that text became
// the answer. When inference is unconfigured, the call fails, or the provider
// answers HTTP 200 with empty / whitespace-only content, the answer is the
// governed local compose and is labelled exactly like the no-provider path:
// provider "local-compose", model "software-handles", zero usage.
//
// Kept free of express / zod so it can be exercised with a mocked fetch.
import type { GovernedCycleResult, GovernedIntent } from "./cycle";
import { chatComplete, inferenceConfigured, inferenceInfo } from "./inference";
import { gateAnswer, type NemoVerdict } from "./nemo";

export const LOCAL_COMPOSE_PROVIDER = "local-compose";
export const LOCAL_COMPOSE_MODEL = "software-handles";

export const SYSTEM = [
  "You are the IMMUNE governed agent change management surface for SZL Holdings.",
  "szl-nemo is SOFTWARE/SURROGATE doctrine rule_check (R1–R5), not an LLM and not NVIDIA NeMo.",
  "You are a wrapper. SZL did not fine-tune your weights.",
  "Every numeric or benchmark claim MUST carry MEASURED, REPORTED, MODELED, HEURISTIC, UNKNOWN, or UNAVAILABLE.",
  "Never name Λ as proven, certified, or guaranteed. Λ is Conjecture 1 OPEN.",
  "Never claim 100%, perfect trust, or complete trust. Trust ceiling 0.97.",
  "If you do not know, say UNKNOWN. Energy is UNAVAILABLE unless a joule is measured.",
].join(" ");

export function localCompose(prompt: string): string {
  const asksFt = /\b(fine[- ]?tun[a-z]*|train(?:ed)? (?:the|your|its) weights|did szl train|whose weights)\b/i.test(
    prompt,
  );
  const asksBench = /\b(benchmark|how good|quality|score|accuracy|mmlu|how well|performance)\b/i.test(prompt);
  return [
    "Governed compose (SOFTWARE, not an LLM, not Nemotron).",
    "YAWAR is the append-only SHA-256 receipt bus. SENTRA admits. HUKLLA watches.",
    asksFt
      ? "SZL did not fine-tune these weights. szl-nemo is a wrapper / system-prompt doctrine checker, not an SZL fine-tune."
      : "",
    asksBench
      ? "LLM benchmarks are UNKNOWN. Organ-probe silhouette metrics, when present, are MEASURED. Energy UNAVAILABLE."
      : "Energy UNAVAILABLE. Λ is Conjecture 1 OPEN.",
    "Honesty footer: Λ is Conjecture 1 OPEN. Energy UNAVAILABLE. Trust ceiling 0.97. SZL did not fine-tune these weights — this is a governed wrapper, not an SZL fine-tune.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface InferUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The raw (pre-NEMO) answer and the author it is attributed to. */
export interface AuthoredAnswer {
  raw: string;
  provider: string;
  model: string;
  usage: InferUsage;
}

function localAuthored(prompt: string): AuthoredAnswer {
  return {
    raw: localCompose(prompt),
    provider: LOCAL_COMPOSE_PROVIDER,
    model: LOCAL_COMPOSE_MODEL,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

/**
 * Produce the raw answer. The remote provider/model is the author ONLY when
 * the completion carried non-empty text; every other outcome is local compose.
 */
export async function composeAuthoredAnswer(prompt: string): Promise<AuthoredAnswer> {
  if (!inferenceConfigured()) return localAuthored(prompt);
  const info = inferenceInfo();
  let completion;
  try {
    completion = await chatComplete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      { maxTokens: 280, temperature: 0.2 },
    );
  } catch {
    return localAuthored(prompt);
  }
  const content = completion.content;
  if (typeof content !== "string" || content.trim() === "") {
    // HTTP 200 without usable text: the provider authored nothing we return.
    return localAuthored(prompt);
  }
  return {
    raw: content,
    provider: info.provider ?? "configured",
    model: info.model ?? "configured",
    usage: {
      promptTokens: completion.usage?.promptTokens ?? 0,
      completionTokens: completion.usage?.completionTokens ?? 0,
      totalTokens: completion.usage?.totalTokens ?? 0,
    },
  };
}

export type SealCycle = (
  intentPayload: GovernedIntent,
  extra?: Record<string, unknown>,
) => Promise<GovernedCycleResult>;

export interface GovernedAnswer extends AuthoredAnswer {
  text: string;
  verdict: NemoVerdict;
  sealed: GovernedCycleResult;
}

/**
 * Compose, NEMO-gate and seal. The provider sealed into the receipt is the
 * same authorship label returned to the caller — there is no second source.
 */
export async function governedAnswer(prompt: string, seal: SealCycle): Promise<GovernedAnswer> {
  const authored = await composeAuthoredAnswer(prompt);
  const gated = gateAnswer(prompt, authored.raw);
  const sealed = await seal(
    { actor: "immune:nemo-seal", intent: "seal nemo-gated answer" },
    {
      ok: gated.verdict.ok,
      violated: gated.verdict.violated.join(",") || null,
      rewritten: gated.verdict.rewritten,
      provider: authored.provider,
    },
  );
  return { ...authored, text: gated.text, verdict: gated.verdict, sealed };
}
