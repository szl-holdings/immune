export interface SentraSignature {
  name: string;
  forbiddenSubstrings?: string[];
  requireFields?: string[];
}

const SIGNATURES: SentraSignature[] = [
  {
    name: "intent.required",
    requireFields: ["intent", "actor"],
  },
  {
    name: "no.exfil.tokens",
    forbiddenSubstrings: ["BEGIN PRIVATE KEY", "AKIA", "sk-live-", "sk-prod-"],
  },
  {
    name: "no.shell.escape",
    forbiddenSubstrings: ["$(", "`rm -rf", "../../../"],
  },
];

export interface SentraVerdict {
  accepted: boolean;
  reason: string;
  signatureMatched: string | null;
}

const MAX_INPUT_BYTES = 1_048_576;
const MAX_DEPTH = 32;
const MAX_FIELD_LEN = 65_536;

export function sentraInspect(rawIntent: unknown, mode: "PASS" | "SENTRA_REJECT" | "DEADMAN"): SentraVerdict {
  if (mode === "SENTRA_REJECT") {
    return {
      accepted: false,
      reason: "operator-forced reject (demo: SENTRA_REJECT)",
      signatureMatched: "demo.forced.reject",
    };
  }

  let payload: any;
  try {
    payload = normalize(rawIntent, 0);
  } catch (err: any) {
    return { accepted: false, reason: `dos guard: ${err.message}`, signatureMatched: "guard.dos" };
  }

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) {
    return { accepted: false, reason: "intent exceeds 1MB", signatureMatched: "guard.size" };
  }

  for (const sig of SIGNATURES) {
    if (sig.requireFields) {
      for (const f of sig.requireFields) {
        if (payload?.[f] === undefined || payload?.[f] === null || payload?.[f] === "") {
          return { accepted: false, reason: `missing required field: ${f}`, signatureMatched: sig.name };
        }
      }
    }
    if (sig.forbiddenSubstrings) {
      for (const needle of sig.forbiddenSubstrings) {
        if (serialized.includes(needle)) {
          return { accepted: false, reason: `forbidden token: ${needle}`, signatureMatched: sig.name };
        }
      }
    }
  }

  return { accepted: true, reason: "ok: matched intent.required and clean", signatureMatched: "intent.required" };
}

function normalize(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error(`depth>${MAX_DEPTH}`);
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string") {
    if ((v as string).length > MAX_FIELD_LEN) throw new Error("field>64KiB");
    return v;
  }
  if (t === "number" || t === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = normalize((v as any)[k], depth + 1);
    }
    return out;
  }
  return null;
}

export function listSentraSignatures(): SentraSignature[] {
  return SIGNATURES.map((s) => ({ ...s }));
}
