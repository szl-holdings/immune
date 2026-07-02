// Shared static mirror of IMMUNE's watcher (HUKLLA) -> industry-framework mapping.
//
// This is OUR alignment of each IMMUNE tripwire to the most relevant entry in the
// OWASP Top 10 for LLM Applications (2025) and to MITRE ATLAS. It is an honest,
// self-authored correlation for orientation — it is NOT an official OWASP or MITRE
// mapping. Every OWASP URL below was verified to resolve (HTTP 200) at authoring
// time; ATLAS deep-links are not stably reachable for direct fetch, so we fall back
// to the verified ATLAS root URL per the project's "no unverified URLs" doctrine.

export const OWASP_TOP10_URL = "https://genai.owasp.org/llm-top-10/";
export const ATLAS_URL = "https://atlas.mitre.org/";

export const FRAMEWORK_ALIGNMENT_NOTE =
  "IMMUNE's own alignment of its tripwires to public adversarial-ML frameworks. " +
  "Not an official OWASP or MITRE mapping.";

export interface FrameworkRef {
  /** Short identifier rendered on the badge (e.g. "LLM01", "ATLAS"). */
  id: string;
  /** Human-readable framework entry title. */
  title: string;
  /** Verified external URL (specific page where confirmed, else framework root). */
  url: string;
}

export interface WatcherFramework {
  /** Tripwire id, T01..T10. */
  id: string;
  /** Tripwire name, e.g. "intent.unsigned". */
  name: string;
  owasp: FrameworkRef;
  atlas: FrameworkRef;
  /** Why this tripwire maps to those framework entries (our reasoning). */
  alignmentNote: string;
}

// --- OWASP Top 10 for LLM Apps (2025) entries used in the mapping (verified 200) ---
const OWASP_LLM01: FrameworkRef = {
  id: "LLM01",
  title: "Prompt Injection",
  url: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/",
};
const OWASP_LLM02: FrameworkRef = {
  id: "LLM02",
  title: "Sensitive Information Disclosure",
  url: "https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/",
};
const OWASP_LLM03: FrameworkRef = {
  id: "LLM03",
  title: "Supply Chain",
  url: "https://genai.owasp.org/llmrisk/llm032025-supply-chain/",
};
const OWASP_LLM06: FrameworkRef = {
  id: "LLM06",
  title: "Excessive Agency",
  url: "https://genai.owasp.org/llmrisk/llm062025-excessive-agency/",
};
const OWASP_LLM10: FrameworkRef = {
  id: "LLM10",
  title: "Unbounded Consumption",
  url: "https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/",
};

// MITRE ATLAS reference. Deep technique pages are not reliably fetchable, so we
// link the verified ATLAS root and carry the conceptual tactic only as a label.
function atlasRef(tactic: string): FrameworkRef {
  return { id: "ATLAS", title: tactic, url: ATLAS_URL };
}

export const WATCHER_FRAMEWORKS: Record<string, WatcherFramework> = {
  T01: {
    id: "T01",
    name: "intent.unsigned",
    owasp: OWASP_LLM01,
    atlas: atlasRef("Adversarial input · prompt injection"),
    alignmentNote:
      "An unsigned intent is the classic vector for prompt injection — IMMUNE refuses to act on any intent lacking a valid signature.",
  },
  T02: {
    id: "T02",
    name: "actor.unknown",
    owasp: OWASP_LLM06,
    atlas: atlasRef("Unauthorized agent action"),
    alignmentNote:
      "An unauthenticated actor can drive an agent past its mandate; IMMUNE bounds agency by rejecting unknown actors.",
  },
  T03: {
    id: "T03",
    name: "rate.exceeded",
    owasp: OWASP_LLM10,
    atlas: atlasRef("Denial of ML service"),
    alignmentNote:
      "Excess request rate is resource exhaustion; IMMUNE caps consumption at the gate.",
  },
  T04: {
    id: "T04",
    name: "payload.oversize",
    owasp: OWASP_LLM10,
    atlas: atlasRef("Denial of ML service"),
    alignmentNote:
      "Oversized payloads drive unbounded consumption; IMMUNE rejects them before they reach the model.",
  },
  T05: {
    id: "T05",
    name: "egress.unauthorized",
    owasp: OWASP_LLM02,
    atlas: atlasRef("Exfiltration via inference API"),
    alignmentNote:
      "Unauthorized egress is how sensitive information leaks; IMMUNE blocks data leaving without authorization.",
  },
  T06: {
    id: "T06",
    name: "ledger.divergence",
    owasp: OWASP_LLM03,
    atlas: atlasRef("ML supply-chain compromise"),
    alignmentNote:
      "A diverging ledger signals tampering in the action supply chain; IMMUNE detects the broken hash link.",
  },
  T07: {
    id: "T07",
    name: "deadman.engaged",
    owasp: OWASP_LLM06,
    atlas: atlasRef("Kill-switch / agency control"),
    alignmentNote:
      "The dead-man switch is the hard control on excessive agency — IMMUNE can freeze all action instantly.",
  },
  T08: {
    id: "T08",
    name: "sentra.bypass",
    owasp: OWASP_LLM06,
    atlas: atlasRef("Guardrail bypass"),
    alignmentNote:
      "Bypassing the policy gate is unchecked agency; IMMUNE treats any Sentra bypass as a hard stop.",
  },
  T09: {
    id: "T09",
    name: "clock.skew",
    owasp: OWASP_LLM03,
    atlas: atlasRef("ML supply-chain integrity"),
    alignmentNote:
      "Clock skew undermines the trust chain that timestamps every receipt; IMMUNE flags it as a supply-chain integrity risk.",
  },
  T10: {
    id: "T10",
    name: "evidence.gap",
    owasp: OWASP_LLM03,
    atlas: atlasRef("Provenance / evidence integrity"),
    alignmentNote:
      "A gap in the evidence chain breaks provenance; IMMUNE requires continuous, verifiable receipts.",
  },
};

/** Ordered T01..T10 list for iteration in UI. */
export const WATCHER_FRAMEWORK_LIST: WatcherFramework[] = Object.values(
  WATCHER_FRAMEWORKS,
).sort((a, b) => a.id.localeCompare(b.id));

/** Lookup a tripwire's framework alignment by id (T01..T10). */
export function getWatcherFramework(id: string): WatcherFramework | undefined {
  return WATCHER_FRAMEWORKS[id];
}
