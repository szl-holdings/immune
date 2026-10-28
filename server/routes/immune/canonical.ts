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

// ---------------------------------------------------------------------------
// szl.immune.canonical/v2 — strict, versioned canonical profile.
//
// Legacy `canonicalBytes` above is frozen: every existing receipt was hashed
// (and possibly signed) over its output, so it must keep reproducing those exact
// bytes, including its known gaps. Do not change it.
//
// v2 is a separate profile for NEW records only. It never assigns into a plain
// object (it serializes directly), so an accepted own key can never vanish, and
// it fails closed on everything the TS and Python implementations could disagree
// on. Shared vectors: contracts/immune-canonical-v2-vectors.json.
//   * own "__proto__" keys are rejected at any depth (proto_key)
//   * keys sort by UTF-16 code units; integer-like keys are not special
//   * strings and keys must be well-formed Unicode (lone_surrogate); length is
//     counted in UTF-16 code units (too_long)
//   * numbers are safe integers; -0 serializes as 0 (JSON value semantics)
//   * only plain/null-prototype objects with own enumerable data properties,
//     dense arrays, strings, booleans and null are accepted
// ---------------------------------------------------------------------------

export const CANONICAL_V2_PROFILE = "szl.immune.canonical/v2" as const;

export type CanonicalV2ErrorCode =
  | "proto_key"
  | "lone_surrogate"
  | "too_long"
  | "non_integer"
  | "unsafe_integer"
  | "unsupported_type"
  | "non_plain_object"
  | "sparse_array"
  | "depth"
  | "too_large";

export class CanonicalV2Error extends CanonicalError {
  readonly code: CanonicalV2ErrorCode;
  constructor(code: CanonicalV2ErrorCode, message: string) {
    super(message);
    this.name = "CanonicalV2Error";
    this.code = code;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function encodeV2String(value: string, path: string, what: "string" | "key"): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalV2Error("lone_surrogate", `lone surrogate in ${what} at ${path}`);
  }
  if (value.length > MAX_FIELD_LEN) {
    throw new CanonicalV2Error("too_long", `${what} too long at ${path}`);
  }
  return JSON.stringify(value);
}

function encodeV2(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalV2Error("depth", `max depth ${MAX_DEPTH} exceeded at ${path}`);
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isInteger(value)) {
        throw new CanonicalV2Error("non_integer", `non-integer number at ${path}`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalV2Error("unsafe_integer", `unsafe integer at ${path}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return encodeV2String(value, path, "string");
    case "object":
      break;
    default:
      throw new CanonicalV2Error("unsupported_type", `unsupported type ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new CanonicalV2Error("non_plain_object", `non-plain array at ${path}`);
    }
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new CanonicalV2Error("sparse_array", `array hole at ${path}[${i}]`);
      }
      parts.push(encodeV2(value[i], `${path}[${i}]`, depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalV2Error("non_plain_object", `non-plain object at ${path}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalV2Error("non_plain_object", `symbol key at ${path}`);
  }
  const keys = Object.getOwnPropertyNames(value);
  const parts: string[] = [];
  // Default sort compares UTF-16 code unit sequences, which is the v2 rule.
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new CanonicalV2Error("non_plain_object", `non-data or hidden property at ${path}`);
    }
    if (key === "__proto__") {
      throw new CanonicalV2Error("proto_key", `own __proto__ key rejected at ${path}`);
    }
    const encodedKey = encodeV2String(key, path, "key");
    parts.push(`${encodedKey}:${encodeV2(descriptor.value, `${path}.${key}`, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalBytesV2(payload: unknown): Buffer {
  const buf = Buffer.from(encodeV2(payload, "$", 0), "utf8");
  if (buf.byteLength > MAX_BYTES) {
    throw new CanonicalV2Error("too_large", `payload exceeds ${MAX_BYTES} bytes`);
  }
  return buf;
}

export function hashCanonicalV2(payload: unknown): {
  hash: string;
  bytes: Buffer;
  profile: typeof CANONICAL_V2_PROFILE;
} {
  const bytes = canonicalBytesV2(payload);
  return { hash: sha256Hex(bytes), bytes, profile: CANONICAL_V2_PROFILE };
}
