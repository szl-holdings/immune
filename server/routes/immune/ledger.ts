import fs from "fs";
import path from "path";
import { canonicalBytes, sha256Hex, CanonicalError } from "./canonical";
import { signReceiptBytes, verifyReceiptSignature, officialPublicKeyB64 } from "./signing";

// The append-only chain lives under data/immune by default. IMMUNE_DATA_DIR lets
// a deploy (or a test) point at a different writable dir without touching cwd.
const DATA_DIR = process.env.IMMUNE_DATA_DIR
  ? path.resolve(process.env.IMMUNE_DATA_DIR)
  : path.resolve(process.cwd(), "data", "immune");
const LEDGER_PATH = path.join(DATA_DIR, "ledger.jsonl");
const EVIDENCE_PATH = path.join(DATA_DIR, "huklla_evidence.jsonl");

export interface LedgerDurability {
  required: true;
  verified: boolean;
  path: string;
  mount_path: "/data";
  reason: string;
}

type DurabilityStat = Pick<fs.Stats,
  "dev" | "ino" | "isDirectory" | "isFile" | "isSymbolicLink">;

export interface LedgerDurabilityFileSystem {
  readMountInfo(): string;
  lstat(file: string): DurabilityStat;
  realpath(file: string): string;
  access(file: string): void;
  openExisting(file: string): number;
  fstat(descriptor: number): DurabilityStat;
  fsync(descriptor: number): void;
  close(descriptor: number): void;
}

const DURABILITY_FILESYSTEM: LedgerDurabilityFileSystem = {
  readMountInfo: () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
  lstat: (file) => fs.lstatSync(file),
  realpath: (file) => fs.realpathSync(file),
  access: (file) => fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK),
  // Never create, truncate, seed, migrate, or append evidence during a probe.
  openExisting: (file) => fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW),
  fstat: (descriptor) => fs.fstatSync(descriptor),
  fsync: (descriptor) => fs.fsyncSync(descriptor),
  close: (descriptor) => fs.closeSync(descriptor),
};

export function ledgerDurability(options: {
  dataDir?: string;
  fileSystem?: LedgerDurabilityFileSystem;
} = {}): LedgerDurability {
  const dataDir = options.dataDir ?? DATA_DIR;
  const io = options.fileSystem ?? DURABILITY_FILESYSTEM;
  const report = (verified: boolean, reason: string): LedgerDurability => ({
    required: true,
    verified,
    path: dataDir,
    mount_path: "/data",
    reason,
  });
  if (dataDir !== "/data/immune/evidence") {
    return report(false, "receipt evidence is not configured at /data/immune/evidence");
  }
  try {
    const mounts = io.readMountInfo().split(/\r?\n/).filter(Boolean).map((line) => {
      const parts = line.split(" - ");
      if (parts.length !== 2) throw new Error("malformed mount observation");
      const fields = parts[0].split(" ");
      const filesystem = parts[1].split(" ");
      if (fields.length < 6 || filesystem.length < 3) throw new Error("malformed mount observation");
      return {
        id: fields[0],
        point: fields[4].replace(/\\([0-7]{3})/g, (_match, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8))),
        options: fields[5].split(","),
        filesystem: filesystem[0],
        superOptions: filesystem[2].split(","),
      };
    });
    const dataMounts = mounts.filter((mount) => mount.point === "/data");
    if (dataMounts.length !== 1) {
      return report(false, "exact persistent /data mount is unavailable or ambiguous");
    }
    const dataMount = dataMounts[0];
    if (
      !dataMount.options.includes("rw") ||
      !dataMount.superOptions.includes("rw") ||
      ["", "overlay", "tmpfs", "ramfs", "squashfs"].includes(dataMount.filesystem)
    ) {
      return report(false, "/data is not a writable persistent filesystem");
    }
    const targets = [
      "/data/immune", dataDir,
      `${dataDir}/ledger.jsonl`, `${dataDir}/huklla_evidence.jsonl`,
    ];
    for (const target of targets) {
      const covering = mounts.filter((mount) =>
        target === mount.point || target.startsWith(`${mount.point}/`),
      ).sort((left, right) => right.point.length - left.point.length);
      if (covering[0]?.id !== dataMount.id) {
        return report(false, "authority and evidence paths are not on the same /data mount");
      }
    }
    const dataStat = io.lstat("/data");
    for (const directory of ["/data", "/data/immune", dataDir]) {
      const stat = io.lstat(directory);
      if (
        !stat.isDirectory() || stat.isSymbolicLink() ||
        stat.dev !== dataStat.dev || io.realpath(directory) !== directory
      ) {
        return report(false, "receipt evidence directory is symlinked or outside the /data filesystem");
      }
      io.access(directory);
    }
    for (const file of targets.slice(2)) {
      const stat = io.lstat(file);
      if (
        !stat.isFile() || stat.isSymbolicLink() || stat.dev !== dataStat.dev ||
        io.realpath(file) !== file
      ) {
        return report(false, "receipt evidence file is not a regular /data file");
      }
      let descriptor: number | undefined;
      try {
        descriptor = io.openExisting(file);
        const opened = io.fstat(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          return report(false, "receipt evidence file changed during durability observation");
        }
        io.fsync(descriptor);
      } finally {
        if (descriptor !== undefined) io.close(descriptor);
      }
    }
    return report(true, "existing YAWAR and HUKLLA files are writable and fsync-capable on the exact /data mount; restart proof remains separate");
  } catch {
    return report(false, "receipt evidence storage is missing, inaccessible, or not fsync-capable");
  }
}

export interface Receipt {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
  payload: Record<string, unknown>;
  // Optional Ed25519 signature (sibling fields — NOT part of the hashed view,
  // so unsigned seeded receipts keep verifying unchanged).
  alg?: "ed25519";
  sig?: string;
  pub?: string;
  kid?: string;
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
  const signature = signReceiptBytes(bytes);
  if (signature) {
    receipt.alg = signature.alg;
    receipt.sig = signature.sig;
    receipt.pub = signature.pub;
    receipt.kid = signature.kid;
  }
  fsyncAppend(JSON.stringify(receipt) + "\n");
  all.push(receipt);
  return receipt;
}

export function appendReceipt(
  input: AppendInput,
  beforeAppend?: () => void,
): Promise<Receipt> {
  const commit = () => {
    beforeAppend?.();
    return appendReceiptSync(input);
  };
  const next = appendChain.then(
    commit,
    commit,
  );
  appendChain = next;
  return next;
}

export interface VerifierIssue {
  seq: number;
  kind: "bad_hash" | "bad_prev" | "bad_sequence" | "parse_error" | "bad_payload" | "bad_sig" | "untrusted_key";
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
    let bytes: Buffer;
    try {
      bytes = canonicalBytes({
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
    // Signatures are OPTIONAL — only verify when a receipt carries one, so the
    // seeded unsigned chain still verifies. A present-but-invalid signature is a
    // real integrity failure; a valid signature under a key other than the
    // published one is flagged as untrusted (authenticity, not integrity).
    if (parsed.sig) {
      if (!verifyReceiptSignature(bytes, parsed)) {
        flag(parsed.seq ?? lineSeq, "bad_sig", `ed25519 signature does not match receipt bytes`);
      } else {
        const official = officialPublicKeyB64();
        if (official && parsed.pub && parsed.pub !== official) {
          flag(parsed.seq ?? lineSeq, "untrusted_key", `signed by kid ${String(parsed.kid).slice(0, 8)} — not the published key`);
        }
      }
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
