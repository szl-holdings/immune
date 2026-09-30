import crypto from "node:crypto";
import {
  ACTION_AUDIENCE,
  ACTION_DEPLOYMENT_SPACE,
  ACTION_ENVELOPE_VERSION,
  ACTION_SOURCE_REPOSITORY,
  MAX_AUTHORITY_LEASE_MS,
  MAX_PASS_AUTHORITY_LEASE_MS,
  SignedActionEnvelopeSchema,
  actionEnvelopeBytes,
  type SignedActionEnvelope,
} from "./state";

const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const AUTHORITY_INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const TRUST_EPOCH_PATTERN = /^[a-f0-9]{32}$/;
const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ExternalOperatorIdentity {
  privateKey: crypto.KeyObject;
  publicKeyB64: string;
  keyId: string;
}

function canonicalBase64(value: string, label: string): Buffer {
  if (!value || value.trim() !== value) {
    throw new Error(`${label} is missing or not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} is missing or not canonical base64`);
  }
  return decoded;
}

export function loadExternalOperatorIdentity(
  privateKeyPkcs8B64: string | undefined,
  expectedPublicKeyB64: string | undefined,
): ExternalOperatorIdentity {
  if (!privateKeyPkcs8B64 || !expectedPublicKeyB64) {
    throw new Error("external operator signing key and public trust pin are both required");
  }
  const privateDer = canonicalBase64(
    privateKeyPkcs8B64,
    "IMMUNE_ACTION_SIGNING_PKCS8_B64",
  );
  const expectedPublic = canonicalBase64(
    expectedPublicKeyB64,
    "IMMUNE_ACTION_PUBLIC_KEY",
  );
  if (expectedPublic.length !== 32) {
    throw new Error("IMMUNE_ACTION_PUBLIC_KEY must encode exactly 32 bytes");
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({
      key: privateDer,
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("external operator signing key is not valid PKCS#8");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("external operator signing key must be Ed25519");
  }
  const publicDer = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" }) as Buffer;
  const publicRaw = publicDer.subarray(-32);
  if (
    publicRaw.length !== expectedPublic.length ||
    !crypto.timingSafeEqual(publicRaw, expectedPublic)
  ) {
    throw new Error("external operator signing key does not match the public trust pin");
  }
  return {
    privateKey,
    publicKeyB64: publicRaw.toString("base64"),
    keyId: crypto.createHash("sha256").update(publicRaw).digest("hex").slice(0, 16),
  };
}

export interface CreateExternalActionOptions {
  identity: ExternalOperatorIdentity;
  requestId: string;
  actor: string;
  sourceRevision: string;
  deploymentRevision: string;
  trustEpoch: string;
  authorityInstanceId: string;
  expectedRevision: number;
  expectedReceiptHash: string;
  action: SignedActionEnvelope["action"];
  leaseMinutes: number;
  now?: Date;
}

export function createExternalActionEnvelope(
  options: CreateExternalActionOptions,
): SignedActionEnvelope {
  if (!SOURCE_REVISION_PATTERN.test(options.sourceRevision)) {
    throw new Error("external operator source must be an exact lowercase 40-hex revision");
  }
  if (!SOURCE_REVISION_PATTERN.test(options.deploymentRevision)) {
    throw new Error("external operator deployment must be an exact lowercase 40-hex revision");
  }
  if (!TRUST_EPOCH_PATTERN.test(options.trustEpoch)) {
    throw new Error("external operator trust epoch must be an exact lowercase 32-hex value");
  }
  if (!AUTHORITY_INSTANCE_ID_PATTERN.test(options.authorityInstanceId)) {
    throw new Error("external operator authority instance must be an exact lowercase 32-hex value");
  }
  if (!Number.isInteger(options.expectedRevision) || options.expectedRevision < 0) {
    throw new Error("external operator expected revision must be a non-negative integer");
  }
  if (
    (options.expectedRevision === 0 && options.expectedReceiptHash !== "GENESIS") ||
    (options.expectedRevision > 0 && !RECEIPT_HASH_PATTERN.test(options.expectedReceiptHash))
  ) {
    throw new Error("external operator expected receipt hash does not match the expected revision");
  }
  if (
    !Number.isInteger(options.leaseMinutes) ||
    options.leaseMinutes < 5 ||
    options.leaseMinutes >
      (options.action.type === "RESET" ||
      (options.action.type === "SET_MODE" && options.action.mode === "PASS")
        ? MAX_PASS_AUTHORITY_LEASE_MS
        : MAX_AUTHORITY_LEASE_MS) /
        60_000
  ) {
    throw new Error(
      "authority lease must be an integer from 5 through the action-specific validity cap",
    );
  }
  const issuedAt = options.now ?? new Date();
  const unsigned: Omit<SignedActionEnvelope, "signature"> = {
    version: ACTION_ENVELOPE_VERSION,
    requestId: options.requestId,
    trustEpoch: options.trustEpoch,
    authorityInstanceId: options.authorityInstanceId,
    expectedRevision: options.expectedRevision,
    expectedReceiptHash: options.expectedReceiptHash,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
    validUntil: new Date(
      issuedAt.getTime() + options.leaseMinutes * 60_000,
    ).toISOString(),
    actor: options.actor,
    keyId: options.identity.keyId,
    audience: ACTION_AUDIENCE,
    source: {
      repository: ACTION_SOURCE_REPOSITORY,
      revision: options.sourceRevision,
    },
    deployment: {
      space: ACTION_DEPLOYMENT_SPACE,
      revision: options.deploymentRevision,
    },
    action: options.action,
  };
  return SignedActionEnvelopeSchema.parse({
    ...unsigned,
    signature: crypto
      .sign(null, actionEnvelopeBytes(unsigned), options.identity.privateKey)
      .toString("base64"),
  });
}
