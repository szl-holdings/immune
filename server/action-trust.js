import crypto from "node:crypto";
import fs from "node:fs";

export const ACTION_TRUST_SCHEMA = "szl.immune-action-trust/v1";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUST_EPOCH_PATTERN = /^[a-f0-9]{32}$/;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const VOLUME_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n")
  );
}

function canonicalBase64(value, expectedBytes, label) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} is missing or not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== expectedBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(`${label} is not canonical base64 for ${expectedBytes} bytes`);
  }
  return decoded;
}

export function actionTrustProofMessage(
  publicKeyB64,
  keyId,
  trustEpoch,
  volumeSource,
) {
  return Buffer.from(
    [
      ACTION_TRUST_SCHEMA,
      "repository=szl-holdings/immune",
      "space=SZLHOLDINGS/immune",
      `public_key=${publicKeyB64}`,
      `key_id=${keyId}`,
      `trust_epoch=${trustEpoch}`,
      `authority_volume_source=${volumeSource}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

export function parseActionTrustDocument(value) {
  if (
    exactKeys(value, ["schema", "configured"]) &&
    value.schema === ACTION_TRUST_SCHEMA &&
    value.configured === false
  ) {
    return Object.freeze({
      schema: ACTION_TRUST_SCHEMA,
      configured: false,
    });
  }
  if (
    !exactKeys(value, [
      "schema",
      "configured",
      "publicKeyB64",
      "keyId",
      "trustEpoch",
      "possessionProofB64",
      "durability",
    ]) ||
    value.schema !== ACTION_TRUST_SCHEMA ||
    value.configured !== true ||
    !KEY_ID_PATTERN.test(String(value.keyId ?? "")) ||
    !TRUST_EPOCH_PATTERN.test(String(value.trustEpoch ?? "")) ||
    !SIGNATURE_PATTERN.test(String(value.possessionProofB64 ?? "")) ||
    !exactKeys(value.durability, [
      "kind",
      "source",
      "mountPath",
      "authorityDataDir",
    ]) ||
    value.durability.kind !== "hf-write-volume-v1" ||
    !VOLUME_SOURCE_PATTERN.test(String(value.durability.source ?? "")) ||
    value.durability.mountPath !== "/data" ||
    value.durability.authorityDataDir !== "/data/immune"
  ) {
    throw new Error("action trust document is malformed or contains unknown fields");
  }
  const publicRaw = canonicalBase64(
    value.publicKeyB64,
    32,
    "action trust public key",
  );
  const keyId = crypto
    .createHash("sha256")
    .update(publicRaw)
    .digest("hex")
    .slice(0, 16);
  if (keyId !== value.keyId) {
    throw new Error("action trust keyId does not match the public key");
  }
  const signature = canonicalBase64(
    value.possessionProofB64,
    64,
    "action trust possession proof",
  );
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicRaw]),
    format: "der",
    type: "spki",
  });
  if (
    !crypto.verify(
      null,
      actionTrustProofMessage(
        value.publicKeyB64,
        keyId,
        value.trustEpoch,
        value.durability.source,
      ),
      publicKey,
      signature,
    )
  ) {
    throw new Error("action trust possession proof does not match the public key");
  }
  return Object.freeze({
    schema: ACTION_TRUST_SCHEMA,
    configured: true,
    publicKeyB64: value.publicKeyB64,
    keyId,
    trustEpoch: value.trustEpoch,
    possessionProofB64: value.possessionProofB64,
    durability: Object.freeze({ ...value.durability }),
  });
}

export function actionTrustDocumentFromEnvironment(environment = process.env) {
  const publicKeyB64 = String(environment.IMMUNE_ACTION_PUBLIC_KEY ?? "");
  const trustEpoch = String(environment.IMMUNE_ACTION_TRUST_EPOCH ?? "");
  const possessionProofB64 = String(
    environment.IMMUNE_ACTION_TRUST_PROOF_B64 ?? "",
  );
  const volumeSource = String(
    environment.IMMUNE_AUTHORITY_VOLUME_SOURCE ?? "",
  );
  if (!publicKeyB64 && !trustEpoch && !possessionProofB64 && !volumeSource) {
    return parseActionTrustDocument({
      schema: ACTION_TRUST_SCHEMA,
      configured: false,
    });
  }
  const publicRaw = canonicalBase64(
    publicKeyB64,
    32,
    "IMMUNE_ACTION_PUBLIC_KEY",
  );
  const keyId = crypto
    .createHash("sha256")
    .update(publicRaw)
    .digest("hex")
    .slice(0, 16);
  return parseActionTrustDocument({
    schema: ACTION_TRUST_SCHEMA,
    configured: true,
    publicKeyB64,
    keyId,
    trustEpoch,
    possessionProofB64,
    durability: {
      kind: "hf-write-volume-v1",
      source: volumeSource,
      mountPath: "/data",
      authorityDataDir: "/data/immune",
    },
  });
}

export function loadActionTrustDocument(filePath) {
  return parseActionTrustDocument(
    JSON.parse(fs.readFileSync(filePath, "utf8")),
  );
}
