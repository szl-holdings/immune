import crypto from "node:crypto";
import {
  ACTION_ENVELOPE_VERSION,
  actionEnvelopeBytes,
  applySignedAction,
  getState,
  type SignedActionEnvelope,
} from "./state";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const REFRESH_MS = 30_000;
const REFRESH_LEAD_MS = 90_000;
const ACTION_TTL_MS = 4 * 60_000 + 30_000;
const TRIPWIRE_IDS = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"] as const;
type TripwireId = (typeof TRIPWIRE_IDS)[number];

export type OperatorIdentity = {
  privateKey: crypto.KeyObject;
  publicKeyB64: string;
  keyId: string;
  demo: boolean;
};

function publicRawFromPrivate(pk: crypto.KeyObject): Buffer {
  const spki = crypto.createPublicKey(pk).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function parsePrivateKey(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length === 32) {
    return crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
  }
  return crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
}

function requestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function asTripwire(value: string | null | undefined): TripwireId {
  return TRIPWIRE_IDS.includes(value as TripwireId) ? (value as TripwireId) : "T07";
}

export function loadDemoOperatorIdentity(): OperatorIdentity | null {
  const demo = process.env.IMMUNE_DEMO_OPERATOR === "1";
  const privB64 = process.env.IMMUNE_ACTION_PRIVATE_KEY;
  if (!demo && !privB64) return null;

  if (privB64) {
    const privateKey = parsePrivateKey(privB64);
    const pub = publicRawFromPrivate(privateKey);
    const publicKeyB64 = pub.toString("base64");
    const configured = process.env.IMMUNE_ACTION_PUBLIC_KEY;
    if (configured && configured !== publicKeyB64) {
      throw new Error("IMMUNE_ACTION_PRIVATE_KEY does not match IMMUNE_ACTION_PUBLIC_KEY");
    }
    return {
      privateKey,
      publicKeyB64,
      keyId: crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16),
      demo,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(-32);
  return {
    privateKey,
    publicKeyB64: raw.toString("base64"),
    keyId: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16),
    demo: true,
  };
}

export function signOperatorAction(
  identity: OperatorIdentity,
  action: SignedActionEnvelope["action"],
  actor: string,
  now = new Date(),
): SignedActionEnvelope {
  const unsigned: Omit<SignedActionEnvelope, "signature"> = {
    version: ACTION_ENVELOPE_VERSION,
    requestId: requestId("genesis"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
    actor,
    keyId: identity.keyId,
    action,
  };
  return {
    ...unsigned,
    signature: crypto.sign(null, actionEnvelopeBytes(unsigned), identity.privateKey).toString("base64"),
  };
}

function needsRefresh(): boolean {
  const snap = getState();
  if (snap.evidenceState !== "VERIFIED" || !snap.validUntil) return true;
  const remaining = Date.parse(snap.validUntil) - Date.now();
  return !Number.isFinite(remaining) || remaining <= REFRESH_LEAD_MS;
}

function applyGenesis(identity: OperatorIdentity): void {
  const snap = getState();
  const mode = snap.evidenceState === "VERIFIED" ? snap.mode : "PASS";
  const action: SignedActionEnvelope["action"] =
    mode === "DEADMAN"
      ? { type: "SET_MODE", mode: "DEADMAN", tripwire: asTripwire(snap.tripwire) }
      : { type: "SET_MODE", mode };
  const envelope = signOperatorAction(
    identity,
    action,
    identity.demo ? "immune:demo-operator" : "immune:bootstrap-operator",
  );
  applySignedAction(envelope);
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function bootDemoOperator(): { enabled: boolean; keyId: string | null; demo: boolean } {
  const identity = loadDemoOperatorIdentity();
  if (!identity) return { enabled: false, keyId: null, demo: false };

  process.env.IMMUNE_ACTION_PUBLIC_KEY = identity.publicKeyB64;
  try {
    if (needsRefresh()) applyGenesis(identity);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "[immune] operator genesis failed (fail-closed):",
      error instanceof Error ? error.message : String(error),
    );
    return { enabled: false, keyId: identity.keyId, demo: identity.demo };
  }

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      try {
        if (needsRefresh()) applyGenesis(identity);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          "[immune] operator refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }, REFRESH_MS);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[immune] ${identity.demo ? "demo" : "bootstrap"} operator ready keyId=${identity.keyId}`,
  );
  return { enabled: true, keyId: identity.keyId, demo: identity.demo };
}
