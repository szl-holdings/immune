import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [intentArgument, envelopeArgument] = process.argv.slice(2);
if (!intentArgument || !envelopeArgument || process.argv.length !== 4) {
  throw new Error(
    "usage: node immune-authority-signer.mjs <unsigned-intent.json> <signed-envelope.json>",
  );
}

const privateKeyB64 = process.env.IMMUNE_ACTION_SIGNING_PKCS8_B64;
const publicKeyB64 = process.env.IMMUNE_ACTION_PUBLIC_KEY;
const allowedEnvironment = new Set([
  "IMMUNE_ACTION_SIGNING_PKCS8_B64",
  "IMMUNE_ACTION_PUBLIC_KEY",
]);
// Windows injects this fixed set into every child process even when Node's
// spawn env is otherwise empty. They contain no workflow or network
// credential and are not present in the production Linux `/usr/bin/env -i`
// signer step. Every other inherited name, including GitHub/HF credentials,
// remains a hard failure.
if (process.platform === "win32") {
  for (const name of [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ]) {
    allowedEnvironment.add(name);
  }
}
for (const name of Object.keys(process.env)) {
  if (!allowedEnvironment.has(name)) {
    throw new Error(`offline signer received prohibited environment variable: ${name}`);
  }
}

function canonicalBase64(value, label) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} is missing or not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) {
    throw new Error(`${label} is missing or not canonical base64`);
  }
  return bytes;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("unsigned authority intent has missing or unknown fields");
  }
}

function canonicalize(value, depth = 0) {
  if (depth > 32) throw new Error("canonical payload nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonical payload contains a non-integer");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1));
  }
  const object = record(value, "canonical payload");
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key], depth + 1)]),
  );
}

function canonicalBytes(value) {
  const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
  if (bytes.byteLength > 1_048_576) throw new Error("canonical payload is too large");
  return bytes;
}

const intentPath = path.resolve(intentArgument);
const envelopePath = path.resolve(envelopeArgument);
if (intentPath === envelopePath) {
  throw new Error("signer input and output paths must be distinct");
}
const intent = record(
  JSON.parse(fs.readFileSync(intentPath, "utf8")),
  "unsigned authority intent",
);
exactKeys(intent, [
  "version",
  "requestId",
  "trustEpoch",
  "authorityInstanceId",
  "expectedRevision",
  "expectedReceiptHash",
  "issuedAt",
  "expiresAt",
  "validUntil",
  "actor",
  "keyId",
  "audience",
  "source",
  "deployment",
  "action",
]);
if (
  intent.version !== "immune.action.v2" ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(intent.requestId) ||
  !/^[a-f0-9]{32}$/u.test(intent.trustEpoch) ||
  !/^[a-f0-9]{32}$/u.test(intent.authorityInstanceId) ||
  !Number.isSafeInteger(intent.expectedRevision) ||
  intent.expectedRevision < 0 ||
  (intent.expectedRevision === 0
    ? intent.expectedReceiptHash !== "GENESIS"
    : !/^[a-f0-9]{64}$/u.test(intent.expectedReceiptHash)) ||
  !/^[a-f0-9]{16}$/u.test(intent.keyId) ||
  intent.audience !== "hf-space:SZLHOLDINGS/immune"
) {
  throw new Error("unsigned authority intent identity or CAS binding is invalid");
}
const source = record(intent.source, "unsigned authority source");
exactKeys(source, ["repository", "revision"]);
if (
  source.repository !== "szl-holdings/immune" ||
  !/^[a-f0-9]{40}$/u.test(source.revision)
) {
  throw new Error("unsigned authority source binding is invalid");
}
const deployment = record(intent.deployment, "unsigned authority deployment");
exactKeys(deployment, ["space", "revision"]);
if (
  deployment.space !== "SZLHOLDINGS/immune" ||
  !/^[a-f0-9]{40}$/u.test(deployment.revision)
) {
  throw new Error("unsigned authority deployment binding is invalid");
}
const action = record(intent.action, "unsigned authority action");
exactKeys(action, ["type", "mode"], ["tripwire"]);
if (
  action.type !== "SET_MODE" ||
  !["PASS", "SENTRA_REJECT", "DEADMAN"].includes(action.mode) ||
  (action.mode === "DEADMAN"
    ? !/^T(?:0[1-9]|10)$/u.test(action.tripwire)
    : Object.hasOwn(action, "tripwire"))
) {
  throw new Error("unsigned authority action is invalid");
}
const issuedAt = Date.parse(intent.issuedAt);
const expiresAt = Date.parse(intent.expiresAt);
const validUntil = Date.parse(intent.validUntil);
if (
  !Number.isFinite(issuedAt) ||
  !Number.isFinite(expiresAt) ||
  !Number.isFinite(validUntil) ||
  expiresAt <= issuedAt ||
  expiresAt - issuedAt > 5 * 60_000 ||
  expiresAt <= Date.now() ||
  validUntil <= issuedAt ||
  validUntil - issuedAt >
    (action.mode === "PASS" ? 15 * 60_000 : 24 * 60 * 60_000)
) {
  throw new Error("unsigned authority time bounds are invalid or expired");
}

const privateDer = canonicalBase64(
  privateKeyB64,
  "IMMUNE_ACTION_SIGNING_PKCS8_B64",
);
const expectedPublic = canonicalBase64(
  publicKeyB64,
  "IMMUNE_ACTION_PUBLIC_KEY",
);
if (expectedPublic.byteLength !== 32) {
  throw new Error("IMMUNE_ACTION_PUBLIC_KEY must encode exactly 32 bytes");
}
let privateKey;
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
const derivedPublic = crypto
  .createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .subarray(-32);
if (
  derivedPublic.byteLength !== expectedPublic.byteLength ||
  !crypto.timingSafeEqual(derivedPublic, expectedPublic)
) {
  throw new Error("external operator signing key does not match the public trust pin");
}
const keyId = crypto
  .createHash("sha256")
  .update(derivedPublic)
  .digest("hex")
  .slice(0, 16);
if (keyId !== intent.keyId) {
  throw new Error("unsigned authority intent keyId does not match the owner signer");
}
const signature = crypto
  .sign(null, canonicalBytes(intent), privateKey)
  .toString("base64");
fs.writeFileSync(
  envelopePath,
  `${JSON.stringify({ ...intent, signature }, null, 2)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({
    schema: "szl.immune-offline-signature/v1",
    requestId: intent.requestId,
    keyId,
    envelopeDigest: crypto
      .createHash("sha256")
      .update(canonicalBytes(intent))
      .digest("hex"),
  }),
);
