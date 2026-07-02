// Ed25519 signing for YAWAR receipts.
//
// Honesty contract: signing is OPTIONAL and OFF by default. The private key is
// read ONLY from the IMMUNE_SIGNING_KEY env var (base64 of a 32-byte Ed25519
// seed, OR base64 of a full PKCS8 DER key) — it is NEVER stored in the repo.
// When no key is configured, receipts stay hash-only (unsigned) and every
// surface must say so. Signatures are stored as SIBLING fields on the receipt
// (sig/alg/pub/kid) and are DELIBERATELY excluded from the hashed view, so the
// existing seeded (unsigned) chain keeps verifying byte-for-byte.
import crypto from "crypto";

// SPKI DER prefix for an Ed25519 public key (12 bytes) + 32 raw key bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// PKCS8 DER prefix for an Ed25519 private key (16 bytes) + 32 raw seed bytes.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

let privKey: crypto.KeyObject | null = null;
let pubRawB64: string | null = null;
let kid: string | null = null;

function rawToPublicKey(raw32: Buffer): crypto.KeyObject {
  const der = Buffer.concat([SPKI_PREFIX, raw32]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

function publicRawFromPrivate(pk: crypto.KeyObject): Buffer {
  const spki = pk
    ? (crypto.createPublicKey(pk).export({ format: "der", type: "spki" }) as Buffer)
    : Buffer.alloc(0);
  return spki.subarray(spki.length - 32);
}

function init(): void {
  const b64 = process.env.IMMUNE_SIGNING_KEY;
  if (!b64) return;
  try {
    const raw = Buffer.from(b64, "base64");
    if (raw.length === 32) {
      const der = Buffer.concat([PKCS8_PREFIX, raw]);
      privKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } else {
      privKey = crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    }
    const pubRaw = publicRawFromPrivate(privKey);
    pubRawB64 = pubRaw.toString("base64");
    kid = crypto.createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);
  } catch {
    privKey = null;
    pubRawB64 = null;
    kid = null;
  }
}
init();

export function signingEnabled(): boolean {
  return privKey !== null;
}

export interface ReceiptSignature {
  alg: "ed25519";
  sig: string; // base64 signature over the canonical hashed-view bytes
  pub: string; // base64 raw 32-byte public key (self-contained verification)
  kid: string; // short key id = sha256(pub)[:16]
}

/** Sign the SAME canonical bytes that were SHA-256 hashed. Null when disabled. */
export function signReceiptBytes(bytes: Buffer): ReceiptSignature | null {
  if (!privKey || !pubRawB64 || !kid) return null;
  const sig = crypto.sign(null, bytes, privKey);
  return { alg: "ed25519", sig: sig.toString("base64"), pub: pubRawB64, kid };
}

/** Verify a stored signature against the bytes, using the embedded public key. */
export function verifyReceiptSignature(
  bytes: Buffer,
  sig: { alg?: string; sig?: string; pub?: string },
): boolean {
  if (!sig || sig.alg !== "ed25519" || !sig.sig || !sig.pub) return false;
  try {
    const pubRaw = Buffer.from(sig.pub, "base64");
    if (pubRaw.length !== 32) return false;
    const pubKey = rawToPublicKey(pubRaw);
    return crypto.verify(null, bytes, pubKey, Buffer.from(sig.sig, "base64"));
  } catch {
    return false;
  }
}

/** The server's currently-configured public identity (for GET /pubkey). */
export function publicKeyInfo(): {
  enabled: boolean;
  alg: "ed25519";
  publicKey: string | null;
  kid: string | null;
} {
  return { enabled: signingEnabled(), alg: "ed25519", publicKey: pubRawB64, kid };
}

/** The base64 raw public key currently trusted as "official" (or null). */
export function officialPublicKeyB64(): string | null {
  return pubRawB64;
}
