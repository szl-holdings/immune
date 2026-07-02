import fs from "fs";
import path from "path";
import { canonicalBytes, sha256Hex, CanonicalError } from "./canonical";

const DATA_DIR = path.resolve(process.cwd(), "data", "immune");
const LEDGER_PATH = path.join(DATA_DIR, "ledger.jsonl");
const EVIDENCE_PATH = path.join(DATA_DIR, "huklla_evidence.jsonl");

export interface Receipt {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
  payload: Record<string, unknown>;
}

export interface EvidenceRecord {
  ts: string;
  cycleSeq: number;
  fired: Array<{ id: string; name: string; fired: boolean; severity: string; detail?: string }>;
}

let memCache: Receipt[] | null = null;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll(): Receipt[] {
  if (memCache) return memCache;
  ensureDir();
  if (!fs.existsSync(LEDGER_PATH)) {
    memCache = [];
    return memCache;
  }
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: Receipt[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Receipt);
    } catch {
      // Tampered / partial line — keep going so verifier can flag it
    }
  }
  memCache = out;
  return out;
}

function fsyncAppend(line: string): void {
  ensureDir();
  const fd = fs.openSync(LEDGER_PATH, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function ledgerCount(): number {
  return loadAll().length;
}

export function ledgerLastHash(): string | null {
  const all = loadAll();
  if (all.length === 0) return null;
  return all[all.length - 1].hash;
}

export function ledgerLatest(limit = 25): Receipt[] {
  const all = loadAll();
  return all.slice(-limit).reverse();
}

export interface AppendInput {
  payload: Record<string, unknown>;
  ts?: string;
}

let appendChain: Promise<Receipt> = Promise.resolve(null as unknown as Receipt);

function appendReceiptSync(input: AppendInput): Receipt {
  const all = loadAll();
  const seq = all.length + 1;
  const prevHash = all.length === 0 ? "GENESIS" : all[all.length - 1].hash;
  const ts = input.ts ?? new Date().toISOString();
  const hashedView = {
    seq,
    ts,
    prevHash,
    payload: input.payload,
  };
  let bytes: Buffer;
  let hash: string;
  try {
    bytes = canonicalBytes(hashedView);
    hash = sha256Hex(bytes);
  } catch (err) {
    if (err instanceof CanonicalError) throw err;
    throw new CanonicalError(`canonicalize failed: ${(err as Error).message}`);
  }
  const receipt: Receipt = { seq, ts, prevHash, hash, payload: input.payload };
  fsyncAppend(JSON.stringify(receipt) + "\n");
  all.push(receipt);
  return receipt;
}

export function appendReceipt(input: AppendInput): Promise<Receipt> {
  const next = appendChain.then(
    () => appendReceiptSync(input),
    () => appendReceiptSync(input),
  );
  appendChain = next;
  return next;
}

export interface VerifierIssue {
  seq: number;
  kind: "bad_hash" | "bad_prev" | "bad_sequence" | "parse_error" | "bad_payload";
  detail: string;
}

export interface VerifierReport {
  ok: boolean;
  count: number;
  issues: VerifierIssue[];
  firstBadSeq: number | null;
}

export function verifyLedger(): VerifierReport {
  ensureDir();
  const issues: VerifierIssue[] = [];
  let firstBadSeq: number | null = null;
  const flag = (seq: number, kind: VerifierIssue["kind"], detail: string) => {
    issues.push({ seq, kind, detail });
    if (firstBadSeq === null) firstBadSeq = seq;
  };

  if (!fs.existsSync(LEDGER_PATH)) {
    return { ok: true, count: 0, issues: [], firstBadSeq: null };
  }
  const raw = fs.readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);

  let prevHash = "GENESIS";
  let expectedSeq = 1;
  let parsedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineSeq = i + 1;
    let parsed: any;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (err: any) {
      flag(lineSeq, "parse_error", `line ${lineSeq}: ${err.message}`);
      continue;
    }
    parsedCount++;
    if (parsed.seq !== expectedSeq) {
      flag(parsed.seq ?? lineSeq, "bad_sequence", `expected seq ${expectedSeq}, got ${parsed.seq}`);
    }
    if (parsed.prevHash !== prevHash) {
      flag(parsed.seq ?? lineSeq, "bad_prev", `expected prevHash ${prevHash.slice(0, 12)}…, got ${String(parsed.prevHash).slice(0, 12)}…`);
    }
    let recomputed: string;
    try {
      const bytes = canonicalBytes({
        seq: parsed.seq,
        ts: parsed.ts,
        prevHash: parsed.prevHash,
        payload: parsed.payload,
      });
      recomputed = sha256Hex(bytes);
    } catch (err: any) {
      flag(parsed.seq ?? lineSeq, "bad_payload", `canonicalize failed: ${err.message}`);
      prevHash = parsed.hash;
      expectedSeq = (parsed.seq ?? lineSeq) + 1;
      continue;
    }
    if (recomputed !== parsed.hash) {
      flag(parsed.seq ?? lineSeq, "bad_hash", `hash mismatch — recomputed ${recomputed.slice(0, 12)}…, stored ${String(parsed.hash).slice(0, 12)}…`);
    }
    prevHash = parsed.hash;
    expectedSeq = (parsed.seq ?? lineSeq) + 1;
  }

  return { ok: issues.length === 0, count: parsedCount, issues, firstBadSeq };
}

export function appendEvidence(rec: EvidenceRecord): void {
  ensureDir();
  const fd = fs.openSync(EVIDENCE_PATH, "a");
  try {
    fs.writeSync(fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function evidenceLatest(limit = 25): EvidenceRecord[] {
  ensureDir();
  if (!fs.existsSync(EVIDENCE_PATH)) return [];
  const raw = fs.readFileSync(EVIDENCE_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: EvidenceRecord[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as EvidenceRecord);
    } catch {
      // skip
    }
  }
  return out.slice(-limit).reverse();
}

export function _resetCache(): void {
  memCache = null;
}
