import crypto from "crypto";

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

const MAX_DEPTH = 32;
const MAX_BYTES = 1_048_576;
const MAX_FIELD_LEN = 65_536;

function assertNoFloat(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new CanonicalError(`float disallowed at ${path}: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(`unsafe integer at ${path}: ${value}`);
    }
  }
}

function canonicalize(value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new CanonicalError(`max depth ${MAX_DEPTH} exceeded at ${path}`);
  }
  if (value === null) return null;
  if (value === undefined) {
    throw new CanonicalError(`undefined disallowed at ${path}`);
  }
  const t = typeof value;
  if (t === "boolean") return value;
  if (t === "number") {
    assertNoFloat(value, path);
    return value;
  }
  if (t === "string") {
    if ((value as string).length > MAX_FIELD_LEN) {
      throw new CanonicalError(`string too long at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalize(v, `${path}[${i}]`, depth + 1));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object).sort();
    for (const k of keys) {
      if (k.length > MAX_FIELD_LEN) {
        throw new CanonicalError(`key too long at ${path}.${k}`);
      }
      out[k] = canonicalize((value as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
    }
    return out;
  }
  throw new CanonicalError(`unsupported type ${t} at ${path}`);
}

export function canonicalBytes(payload: unknown): Buffer {
  const normalized = canonicalize(payload, "$", 0);
  const json = JSON.stringify(normalized);
  const buf = Buffer.from(json, "utf8");
  if (buf.byteLength > MAX_BYTES) {
    throw new CanonicalError(`payload exceeds ${MAX_BYTES} bytes`);
  }
  return buf;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hashCanonical(payload: unknown): { hash: string; bytes: Buffer } {
  const bytes = canonicalBytes(payload);
  return { hash: sha256Hex(bytes), bytes };
}
