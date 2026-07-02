import { logger } from "../../lib/logger";
import { HUKLLA_REGISTRY } from "./huklla";

// Real threat-intelligence sources for the IMMUNE investor demo.
//
// DOCTRINE: every externally-sourced datum carries an honest provenance label —
//   LIVE      = fetched from a real public feed right now (Sigstore Rekor)
//   REFERENCE = curated real facts with real citations (MITRE ATLAS case studies)
// Curated URLs that we bake in are best-effort verified (HTTP 200) on first use
// and downgraded to the framework root URL on a miss, so we never assert a link
// we have not seen resolve. A fetch failure is reported honestly, never faked.
//
// This module is ADD-only. It does NOT touch ledger/canonical/sentra/huklla/state.

const OWASP_ROOT = "https://genai.owasp.org/llm-top-10/";
const ATLAS_ROOT = "https://atlas.mitre.org/";
const REKOR_URL = "https://rekor.sigstore.dev/api/v1/log";

const REKOR_NOTE =
  "Sigstore Rekor is a public, append-only transparency log for software-supply-chain " +
  "signatures. IMMUNE applies the same principle — an append-only SHA-256 hash chain — to " +
  "every AI-agent action receipt, so actions cannot be silently altered after the fact.";

export type Provenance = "LIVE" | "REFERENCE" | "UNAVAILABLE";

interface FrameworkRef {
  id: string;
  title: string;
  url: string;
}

interface WatcherSeed {
  id: string;
  owasp: FrameworkRef;
  atlas: FrameworkRef;
  alignmentNote: string;
}

export interface FrameworkWatcher {
  id: string;
  name: string;
  severity: string;
  owasp: FrameworkRef;
  atlas: FrameworkRef;
  alignmentNote: string;
}

export interface FrameworksResponse {
  generatedAt: string;
  watchers: FrameworkWatcher[];
}

// OUR alignment of each HUKLLA watcher to the OWASP LLM Top 10 (2025) and a
// representative MITRE ATLAS technique. This is IMMUNE's own correlation for the
// demo — it is NOT an official OWASP or ATLAS mapping (alignmentNote says so).
const WATCHER_SEEDS: WatcherSeed[] = [
  {
    id: "T01",
    owasp: { id: "LLM01", title: "LLM01 Prompt Injection", url: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/" },
    atlas: { id: "AML.T0051", title: "AML.T0051 LLM Prompt Injection", url: "https://atlas.mitre.org/techniques/AML.T0051" },
    alignmentNote:
      "IMMUNE alignment (not an official OWASP mapping): an unsigned intent is the same trust gap prompt-injection exploits — instructions arriving without a verified signature.",
  },
  {
    id: "T02",
    owasp: { id: "LLM06", title: "LLM06 Excessive Agency", url: "https://genai.owasp.org/llmrisk/llm06-excessive-agency/" },
    atlas: { id: "AML.T0012", title: "AML.T0012 Valid Accounts", url: "https://atlas.mitre.org/techniques/AML.T0012" },
    alignmentNote:
      "IMMUNE alignment: an actor outside the allow-list acting through the agent is excessive agency — authority exercised by an unverified principal.",
  },
  {
    id: "T03",
    owasp: { id: "LLM10", title: "LLM10 Unbounded Consumption", url: "https://genai.owasp.org/llmrisk/llm10-unbounded-consumption/" },
    atlas: { id: "AML.T0034", title: "AML.T0034 Cost Harvesting", url: "https://atlas.mitre.org/techniques/AML.T0034" },
    alignmentNote:
      "IMMUNE alignment: exceeding the operator's cycle budget is unbounded consumption — runaway requests driving cost and denial of service.",
  },
  {
    id: "T04",
    owasp: { id: "LLM10", title: "LLM10 Unbounded Consumption", url: "https://genai.owasp.org/llmrisk/llm10-unbounded-consumption/" },
    atlas: { id: "AML.T0029", title: "AML.T0029 Denial of ML Service", url: "https://atlas.mitre.org/techniques/AML.T0029" },
    alignmentNote:
      "IMMUNE alignment: an oversize canonical payload is unbounded consumption — resource exhaustion via outsized inputs.",
  },
  {
    id: "T05",
    owasp: { id: "LLM02", title: "LLM02 Sensitive Information Disclosure", url: "https://genai.owasp.org/llmrisk/llm02-sensitive-information-disclosure/" },
    atlas: { id: "AML.T0024", title: "AML.T0024 Exfiltration via ML Inference API", url: "https://atlas.mitre.org/techniques/AML.T0024" },
    alignmentNote:
      "IMMUNE alignment: unauthorized egress to a non-allowlisted host is sensitive-information disclosure — data leaving the trust boundary.",
  },
  {
    id: "T06",
    owasp: { id: "LLM03", title: "LLM03 Supply Chain", url: "https://genai.owasp.org/llmrisk/llm03-supply-chain/" },
    atlas: { id: "AML.T0010", title: "AML.T0010 ML Supply Chain Compromise", url: "https://atlas.mitre.org/techniques/AML.T0010" },
    alignmentNote:
      "IMMUNE alignment: a hash-chain divergence is a supply-chain integrity failure — the recorded artifact no longer matches what was produced.",
  },
  {
    id: "T07",
    owasp: { id: "LLM06", title: "LLM06 Excessive Agency", url: "https://genai.owasp.org/llmrisk/llm06-excessive-agency/" },
    atlas: { id: "AML.T0053", title: "AML.T0053 LLM Plugin Compromise", url: "https://atlas.mitre.org/techniques/AML.T0053" },
    alignmentNote:
      "IMMUNE alignment: DEADMAN is the kill-switch control for excessive agency — when engaged the agent's authority to write is revoked outright.",
  },
  {
    id: "T08",
    owasp: { id: "LLM06", title: "LLM06 Excessive Agency", url: "https://genai.owasp.org/llmrisk/llm06-excessive-agency/" },
    atlas: { id: "AML.T0050", title: "AML.T0050 Command and Scripting Interpreter", url: "https://atlas.mitre.org/techniques/AML.T0050" },
    alignmentNote:
      "IMMUNE alignment: a receipt produced without SENTRA acceptance is excessive agency — an action taken with its authorization gate bypassed.",
  },
  {
    id: "T09",
    owasp: { id: "LLM03", title: "LLM03 Supply Chain", url: "https://genai.owasp.org/llmrisk/llm03-supply-chain/" },
    atlas: { id: "AML.T0031", title: "AML.T0031 Erode ML Model Integrity", url: "https://atlas.mitre.org/techniques/AML.T0031" },
    alignmentNote:
      "IMMUNE alignment: clock skew undermines the trustworthy timestamps a supply-chain audit depends on to order and attest events.",
  },
  {
    id: "T10",
    owasp: { id: "LLM03", title: "LLM03 Supply Chain", url: "https://genai.owasp.org/llmrisk/llm03-supply-chain/" },
    atlas: { id: "AML.T0010", title: "AML.T0010 ML Supply Chain Compromise", url: "https://atlas.mitre.org/techniques/AML.T0010" },
    alignmentNote:
      "IMMUNE alignment: a gap in the HUKLLA evidence chain is a supply-chain integrity failure — missing provenance for a cycle that should be accounted for.",
  },
];

export interface CaseStudy {
  id: string;
  name: string;
  summary: string;
  url: string;
}

export interface IncidentsResponse {
  source: "mitre-atlas";
  provenance: "REFERENCE";
  caseStudies: CaseStudy[];
}

// Real MITRE ATLAS case studies with real study URLs (verified on first use).
const INCIDENT_SEEDS: CaseStudy[] = [
  {
    id: "AML.CS0009",
    name: "Tay Poisoning",
    summary:
      "Microsoft's Tay chatbot was manipulated within hours of release as adversarial users poisoned its online-learning loop with abusive inputs, forcing a shutdown.",
    url: "https://atlas.mitre.org/studies/AML.CS0009",
  },
  {
    id: "AML.CS0006",
    name: "ClearviewAI Misconfiguration",
    summary:
      "A misconfigured ClearviewAI source-code repository exposed credentials, keys, and cloud storage, illustrating supply-chain and secrets exposure around an AI product.",
    url: "https://atlas.mitre.org/studies/AML.CS0006",
  },
  {
    id: "AML.CS0000",
    name: "Evasion of Deep Learning Detector for Malware C2 Traffic",
    summary:
      "Researchers crafted adversarial network traffic that evaded a deployed deep-learning command-and-control detector, demonstrating model evasion in production.",
    url: "https://atlas.mitre.org/studies/AML.CS0000",
  },
  {
    id: "AML.CS0016",
    name: "Achieving Code Execution in MathGPT via Prompt Injection",
    summary:
      "A prompt-injection attack against the MathGPT application coerced the underlying model into emitting code that achieved remote code execution on the host.",
    url: "https://atlas.mitre.org/studies/AML.CS0016",
  },
  {
    id: "AML.CS0003",
    name: "Bypassing Cylance's AI Malware Detection",
    summary:
      "Researchers reverse-engineered Cylance's ML malware classifier and appended benign strings to malware to flip its verdict, bypassing AI-based detection.",
    url: "https://atlas.mitre.org/studies/AML.CS0003",
  },
  {
    id: "AML.CS0010",
    name: "Microsoft Azure Service Disruption",
    summary:
      "A red-team exercise abused an ML service's API surface to disrupt an Azure service, showing how inference endpoints expand the attack surface of AI systems.",
    url: "https://atlas.mitre.org/studies/AML.CS0010",
  },
];

export interface Leader {
  name: string;
  what: string;
  url: string;
}

export interface LeaderCategory {
  category: string;
  members: Leader[];
}

export interface LeadersResponse {
  generatedAt: string;
  categories: LeaderCategory[];
}

// Curated registry of the real leaders whose verifiable-AI principles IMMUNE
// implements. Real organizations, real product/standard URLs.
const LEADERS: LeaderCategory[] = [
  {
    category: "Transparency & Provenance",
    members: [
      { name: "Sigstore / Rekor", what: "Public append-only transparency log for software signatures.", url: "https://www.sigstore.dev/" },
      { name: "SLSA", what: "Supply-chain Levels for Software Artifacts — a graded integrity framework.", url: "https://slsa.dev/" },
      { name: "in-toto", what: "Framework for cryptographically attesting every step of a supply chain.", url: "https://in-toto.io/" },
    ],
  },
  {
    category: "Hardware Attestation & Confidential Computing",
    members: [
      { name: "NVIDIA Confidential Computing", what: "GPU trusted execution with hardware attestation for AI workloads.", url: "https://www.nvidia.com/en-us/data-center/solutions/confidential-computing/" },
      { name: "Intel TDX", what: "Trust Domain Extensions — hardware-isolated, attestable VMs.", url: "https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html" },
      { name: "AMD SEV-SNP", what: "Secure Encrypted Virtualization with attestable memory integrity.", url: "https://www.amd.com/en/developer/sev.html" },
      { name: "AWS Nitro Enclaves", what: "Isolated compute environments with cryptographic attestation.", url: "https://aws.amazon.com/ec2/nitro/nitro-enclaves/" },
    ],
  },
  {
    category: "Adversarial-ML Frameworks & Standards",
    members: [
      { name: "MITRE ATLAS", what: "Adversarial Threat Landscape for AI Systems — tactics and techniques.", url: "https://atlas.mitre.org/" },
      { name: "OWASP GenAI / LLM Top 10", what: "The community standard for the top LLM application security risks.", url: "https://genai.owasp.org/llm-top-10/" },
      { name: "NIST AI Risk Management Framework", what: "Government framework for managing AI risk across the lifecycle.", url: "https://www.nist.gov/itl/ai-risk-management-framework" },
    ],
  },
  {
    category: "LLM & AI Security",
    members: [
      { name: "Lakera", what: "Real-time prompt-injection and LLM application security.", url: "https://www.lakera.ai/" },
      { name: "HiddenLayer", what: "Detection and response for machine-learning models in production.", url: "https://hiddenlayer.com/" },
      { name: "Protect AI", what: "Security tooling for the AI/ML supply chain.", url: "https://protectai.com/" },
      { name: "Robust Intelligence", what: "Automated red-teaming and AI firewall for model risk.", url: "https://www.robustintelligence.com/" },
    ],
  },
];

export interface TransparencyResponse {
  source: "sigstore-rekor";
  provenance: "LIVE" | "UNAVAILABLE";
  fetchedAt: string;
  treeSize?: number;
  rootHash?: string;
  url: string;
  note: string;
}

// --- URL verification (best-effort, short timeout, fail-soft) -----------------

async function verifyUrl(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "IMMUNE-intel-verifier/1.0" },
    });
    try {
      await res.body?.cancel();
    } catch {
      // best-effort drain only
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveUrl(label: string, candidate: string, root: string): Promise<string> {
  if (await verifyUrl(candidate)) return candidate;
  logger.warn({ candidate, fallback: root }, `immune.intel: ${label} URL did not resolve 200 — downgrading to framework root`);
  return root;
}

// --- frameworks (verified once, then cached) ----------------------------------

let frameworksCache: FrameworksResponse | null = null;
let frameworksInFlight: Promise<FrameworksResponse> | null = null;

async function buildFrameworks(): Promise<FrameworksResponse> {
  const watchers = await Promise.all(
    WATCHER_SEEDS.map(async (seed): Promise<FrameworkWatcher> => {
      const reg = HUKLLA_REGISTRY.find((t) => t.id === seed.id);
      const [owaspUrl, atlasUrl] = await Promise.all([
        resolveUrl(`${seed.id} OWASP ${seed.owasp.id}`, seed.owasp.url, OWASP_ROOT),
        resolveUrl(`${seed.id} ATLAS ${seed.atlas.id}`, seed.atlas.url, ATLAS_ROOT),
      ]);
      return {
        id: seed.id,
        name: reg?.name ?? seed.id,
        severity: reg?.severity ?? "info",
        owasp: { ...seed.owasp, url: owaspUrl },
        atlas: { ...seed.atlas, url: atlasUrl },
        alignmentNote: seed.alignmentNote,
      };
    }),
  );
  const out: FrameworksResponse = { generatedAt: new Date().toISOString(), watchers };
  frameworksCache = out;
  return out;
}

export function getFrameworks(): Promise<FrameworksResponse> {
  if (frameworksCache) return Promise.resolve(frameworksCache);
  if (!frameworksInFlight) {
    frameworksInFlight = buildFrameworks().catch((err) => {
      frameworksInFlight = null;
      throw err;
    });
  }
  return frameworksInFlight;
}

// --- incidents (verified once, then cached) -----------------------------------

let incidentsCache: IncidentsResponse | null = null;
let incidentsInFlight: Promise<IncidentsResponse> | null = null;

async function buildIncidents(): Promise<IncidentsResponse> {
  const caseStudies = await Promise.all(
    INCIDENT_SEEDS.map(async (cs): Promise<CaseStudy> => {
      const url = await resolveUrl(`incident ${cs.id}`, cs.url, ATLAS_ROOT);
      return { id: cs.id, name: cs.name, summary: cs.summary, url };
    }),
  );
  const out: IncidentsResponse = { source: "mitre-atlas", provenance: "REFERENCE", caseStudies };
  incidentsCache = out;
  return out;
}

export function getIncidents(): Promise<IncidentsResponse> {
  if (incidentsCache) return Promise.resolve(incidentsCache);
  if (!incidentsInFlight) {
    incidentsInFlight = buildIncidents().catch((err) => {
      incidentsInFlight = null;
      throw err;
    });
  }
  return incidentsInFlight;
}

// --- leaders (static) ---------------------------------------------------------

export function getLeaders(): LeadersResponse {
  return { generatedAt: new Date().toISOString(), categories: LEADERS };
}

// --- transparency: LIVE Sigstore Rekor fetch (60s cache, fail-soft) -----------

const REKOR_TTL_MS = 60_000;
let rekorCache: { at: number; data: TransparencyResponse } | null = null;

async function fetchRekor(): Promise<TransparencyResponse> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(REKOR_URL, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json", "user-agent": "IMMUNE-intel/1.0" },
    });
    if (!res.ok) throw new Error(`rekor HTTP ${res.status}`);
    const body = (await res.json()) as { treeSize?: number | string; rootHash?: unknown };
    const treeSize = typeof body.treeSize === "string" ? Number.parseInt(body.treeSize, 10) : body.treeSize;
    const rootHash = body.rootHash;
    if (typeof treeSize !== "number" || !Number.isFinite(treeSize) || typeof rootHash !== "string" || rootHash.length === 0) {
      throw new Error("rekor response missing treeSize/rootHash");
    }
    return { source: "sigstore-rekor", provenance: "LIVE", fetchedAt, treeSize, rootHash, url: REKOR_URL, note: REKOR_NOTE };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "immune.intel: Sigstore Rekor transparency fetch failed");
    return { source: "sigstore-rekor", provenance: "UNAVAILABLE", fetchedAt, url: REKOR_URL, note: REKOR_NOTE };
  }
}

export async function getTransparency(): Promise<TransparencyResponse> {
  const now = Date.now();
  if (rekorCache && now - rekorCache.at < REKOR_TTL_MS) return rekorCache.data;
  const data = await fetchRekor();
  // Only cache successful LIVE reads; retry sooner after a failure.
  if (data.provenance === "LIVE") rekorCache = { at: now, data };
  return data;
}

// --- pulse: LIVE disclosed-AI-vuln + ecosystem feed (NVD + GitHub + HF) -------
//
// Genuinely live, public, keyless feeds the deployed container fetches itself:
//   - NVD (U.S. National Vulnerability Database) exact-match "prompt injection"
//     CVEs — the same attack class IMMUNE's T01 intent-signature gate stops.
//   - GitHub repo activity (stars, last push) for the open standards we align to.
//   - Hugging Face download/like counts for public guardrail models.
// Every datum carries a provenance label; a failed fetch is reported UNAVAILABLE
// and its numbers are omitted — never fabricated.

const NVD_API =
  "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=prompt%20injection&keywordExactMatch&resultsPerPage=8";
const NVD_HUMAN =
  "https://nvd.nist.gov/vuln/search/results?form_type=Basic&query=prompt+injection&search_type=all";
const PULSE_REPOS = [
  "sigstore/rekor",
  "slsa-framework/slsa",
  "in-toto/in-toto",
  "mitre-atlas/atlas-data",
];
const PULSE_MODELS = ["meta-llama/Llama-Guard-3-8B"];
const PULSE_TTL_MS = 15 * 60_000;

export interface PulseVuln {
  id: string;
  published: string;
  summary: string;
  url: string;
}
export interface PulseVulns {
  source: "nvd";
  provenance: "LIVE" | "UNAVAILABLE";
  query: string;
  matched?: number;
  url: string;
  fetchedAt: string;
  items: PulseVuln[];
  note: string;
}
export interface PulseRepo {
  name: string;
  url: string;
  provenance: "LIVE" | "UNAVAILABLE";
  stars?: number;
  pushedAt?: string;
  openIssues?: number;
}
export interface PulseModel {
  name: string;
  url: string;
  provenance: "LIVE" | "UNAVAILABLE";
  downloads?: number;
  likes?: number;
}
export interface PulseEcosystem {
  fetchedAt: string;
  repos: PulseRepo[];
  models: PulseModel[];
  note: string;
}
export interface PulseResponse {
  generatedAt: string;
  vulnerabilities: PulseVulns;
  ecosystem: PulseEcosystem;
}

async function fetchNvd(): Promise<PulseVulns> {
  const fetchedAt = new Date().toISOString();
  const base = {
    source: "nvd" as const,
    query: "prompt injection",
    url: NVD_HUMAN,
    fetchedAt,
    note:
      "Live query of the U.S. National Vulnerability Database (NVD) for disclosed " +
      "'prompt injection' CVEs — the attack class IMMUNE's T01 intent-signature gate is built to stop.",
  };
  try {
    const res = await fetch(NVD_API, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json", "user-agent": "IMMUNE-intel/1.0" },
    });
    if (!res.ok) throw new Error(`nvd HTTP ${res.status}`);
    const body = (await res.json()) as {
      totalResults?: number;
      vulnerabilities?: Array<{ cve?: Record<string, unknown> }>;
    };
    const raw = Array.isArray(body.vulnerabilities) ? body.vulnerabilities : [];
    const items: PulseVuln[] = raw
      .map((v) => v.cve)
      .filter((c): c is Record<string, unknown> => !!c && typeof c.id === "string")
      .map((c) => {
        const descriptions = Array.isArray(c.descriptions)
          ? (c.descriptions as Array<{ lang?: string; value?: string }>)
          : [];
        const desc = descriptions.find((d) => d.lang === "en")?.value ?? "";
        const publishedRaw = typeof c.published === "string" ? c.published : "";
        const id = c.id as string;
        return {
          id,
          published: publishedRaw.slice(0, 10),
          summary: desc.length > 180 ? `${desc.slice(0, 180)}…` : desc,
          url: `https://nvd.nist.gov/vuln/detail/${id}`,
        };
      })
      .sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0))
      .slice(0, 6);
    return {
      ...base,
      provenance: "LIVE",
      matched: typeof body.totalResults === "number" ? body.totalResults : undefined,
      items,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "immune.intel: NVD prompt-injection feed failed");
    return { ...base, provenance: "UNAVAILABLE", items: [] };
  }
}

async function fetchRepo(name: string): Promise<PulseRepo> {
  const url = `https://github.com/${name}`;
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "IMMUNE-intel/1.0",
    };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${name}`, {
      signal: AbortSignal.timeout(6000),
      headers,
    });
    if (!res.ok) throw new Error(`github HTTP ${res.status}`);
    const b = (await res.json()) as {
      stargazers_count?: number;
      pushed_at?: string;
      open_issues_count?: number;
      html_url?: string;
    };
    return {
      name,
      url: typeof b.html_url === "string" ? b.html_url : url,
      provenance: "LIVE",
      stars: typeof b.stargazers_count === "number" ? b.stargazers_count : undefined,
      pushedAt: typeof b.pushed_at === "string" ? b.pushed_at.slice(0, 10) : undefined,
      openIssues: typeof b.open_issues_count === "number" ? b.open_issues_count : undefined,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, repo: name }, "immune.intel: GitHub repo feed failed");
    return { name, url, provenance: "UNAVAILABLE" };
  }
}

async function fetchModel(id: string): Promise<PulseModel> {
  const url = `https://huggingface.co/${id}`;
  try {
    const res = await fetch(`https://huggingface.co/api/models/${id}`, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: "application/json", "user-agent": "IMMUNE-intel/1.0" },
    });
    if (!res.ok) throw new Error(`hf HTTP ${res.status}`);
    const b = (await res.json()) as { downloads?: number; likes?: number };
    return {
      name: id,
      url,
      provenance: "LIVE",
      downloads: typeof b.downloads === "number" ? b.downloads : undefined,
      likes: typeof b.likes === "number" ? b.likes : undefined,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, model: id }, "immune.intel: Hugging Face model feed failed");
    return { name: id, url, provenance: "UNAVAILABLE" };
  }
}

async function buildPulse(): Promise<PulseResponse> {
  const fetchedAt = new Date().toISOString();
  const [vulnerabilities, repos, models] = await Promise.all([
    fetchNvd(),
    Promise.all(PULSE_REPOS.map(fetchRepo)),
    Promise.all(PULSE_MODELS.map(fetchModel)),
  ]);
  return {
    generatedAt: fetchedAt,
    vulnerabilities,
    ecosystem: {
      fetchedAt,
      repos,
      models,
      note:
        "Live activity of the open standards and public guardrail models IMMUNE " +
        "aligns with — fetched now from GitHub and Hugging Face.",
    },
  };
}

let pulseCache: { at: number; data: PulseResponse } | null = null;
let pulseInFlight: Promise<PulseResponse> | null = null;

export async function getPulse(): Promise<PulseResponse> {
  const now = Date.now();
  if (pulseCache && now - pulseCache.at < PULSE_TTL_MS) return pulseCache.data;
  if (!pulseInFlight) {
    pulseInFlight = buildPulse()
      .then((data) => {
        // Cache the bundle; any UNAVAILABLE items retry on the next TTL window.
        pulseCache = { at: Date.now(), data };
        pulseInFlight = null;
        return data;
      })
      .catch((err) => {
        pulseInFlight = null;
        throw err;
      });
  }
  return pulseInFlight;
}
