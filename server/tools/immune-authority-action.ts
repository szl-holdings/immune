import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithImmutableHubRedirect } from "./immutable-hf-fetch";
import {
  parseActionTrustDocument,
  type ActionTrustDocument,
} from "../action-trust.js";
import {
  ACTION_AUDIENCE,
  ACTION_VERSION,
  DEPLOY_WORKFLOW,
  DIGEST_PATTERN,
  EPOCH_PATTERN,
  INSTANCE_PATTERN,
  KEY_ID_PATTERN,
  REPOSITORY,
  REVISION_PATTERN,
  RUNTIME,
  SPACE,
  assertExactAppliedAction,
  assertVerifiedEvidenceLedger,
  canonicalBytes,
  envelopeDigest,
  parseReleaseReceipt,
  parseSignedEnvelope,
  parseUnsignedEnvelope,
  sha256,
  unsignedEnvelope,
  type ImmuneAction,
  type JsonObject,
  type ReleaseReceipt,
  type SignedActionEnvelope,
  type UnsignedActionEnvelope,
  type VerifiedEvidenceLedger,
} from "./immune-authority-contract";

const HF_API = `https://huggingface.co/api/spaces/${SPACE}`;
const TRIPWIRE_PATTERN = /^T(?:0[1-9]|10)$/u;
type ConfiguredTrust = Extract<ActionTrustDocument, { configured: true }>;

type Discovery = {
  schema: "szl.immune-authority-discovery/v1";
  sourceRevision: string;
  hfRevision: string;
  deployRunId: number;
  deployRunAttempt: number;
  manifestSha256: string;
  outputPaths: string[];
  volume: {
    type: "bucket";
    source: string;
    mountPath: "/data";
    readOnly: false;
  };
  trust: {
    publicKeyB64: string;
    publicKeySha256: string;
    keyId: string;
    trustEpoch: string;
  };
  authority: {
    instanceId: string;
    revision: number;
    receiptHash: string;
    evidenceState: string;
    durabilityPath: string;
    deploymentRevision: string;
  };
  ledger: VerifiedEvidenceLedger;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readObject(file: string, label: string): JsonObject {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return parsed as JsonObject;
}

function writeExclusive(file: string, value: unknown): void {
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function response(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; bytes: Uint8Array; json: JsonObject | null }> {
  const fetched = await fetchWithImmutableHubRedirect(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "szl-immune-authority-network/v3",
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  let value: JsonObject | null = null;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      value = parsed as JsonObject;
    }
  } catch {
    value = null;
  }
  return { status: fetched.status, bytes, json: value };
}

async function json(
  url: string,
  init: RequestInit = {},
  accepted: readonly number[] = [200],
): Promise<JsonObject> {
  const result = await response(url, init);
  if (!accepted.includes(result.status) || !result.json) {
    throw new Error(`request failed closed: HTTP ${result.status} ${url}`);
  }
  return result.json;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function hfHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function currentMain(token: string): Promise<string> {
  const commit = await json(
    `https://api.github.com/repos/${REPOSITORY}/commits/main`,
    { headers: githubHeaders(token) },
  );
  const revision = String(commit.sha ?? "").toLowerCase();
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error("current protected main is unavailable");
  }
  return revision;
}

function canonicalRawPublicKey(value: string): Buffer {
  if (value.trim() !== value) throw new Error("public action key is not canonical base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("public action key must be canonical base64 for exactly 32 bytes");
  }
  return decoded;
}

function writableAuthorityVolume(runtime: JsonObject): Discovery["volume"] {
  const volumes = Array.isArray(runtime.volumes) ? runtime.volumes : [];
  const matches = volumes.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const volume = value as JsonObject;
    return (
      volume.type === "bucket" &&
      (volume.mountPath ?? volume.mount_path) === "/data" &&
      (volume.readOnly ?? volume.read_only) === false &&
      typeof volume.source === "string" &&
      volume.source.length > 0
    );
  }) as JsonObject[];
  if (matches.length !== 1) {
    throw new Error(
      "durable authority state requires exactly one provider-observed writable bucket at /data",
    );
  }
  return {
    type: "bucket",
    source: String(matches[0].source),
    mountPath: "/data",
    readOnly: false,
  };
}

export function assertAuthorityVolumeMatchesTrust(
  volume: Discovery["volume"],
  trust: ConfiguredTrust,
): void {
  if (volume.source !== trust.durability.source) {
    throw new Error("provider authority volume does not match owner-signed trust binding");
  }
}

function exactRemotePaths(manifest: JsonObject): Set<string> {
  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("immutable deploy manifest artifacts are malformed");
  }
  const paths = new Set([
    ".dockerignore",
    "Dockerfile",
    "README.md",
    "hf-deploy-manifest.json",
    "dist/hf-deploy-manifest.json",
    "dist/data/immune/huklla_evidence.jsonl",
    "dist/data/immune/ledger.jsonl",
  ]);
  for (const [artifactPath, digest] of Object.entries(artifacts)) {
    if (
      !artifactPath ||
      artifactPath.startsWith("/") ||
      artifactPath.includes("..") ||
      artifactPath.includes("\\") ||
      !DIGEST_PATTERN.test(String(digest))
    ) {
      throw new Error("immutable deploy manifest contains an unsafe artifact");
    }
    paths.add(`dist/${artifactPath}`);
  }
  return paths;
}

function parseAuthorityHead(
  state: JsonObject,
  trust: ConfiguredTrust,
  hfRevision: string,
): Discovery["authority"] {
  const revision = Number(state.revision);
  const rawHash = state.authorityReceiptHash;
  const receiptHash = revision === 0 ? "GENESIS" : String(rawHash ?? "");
  const durabilityPath = String(state.authority?.durability?.path ?? "");
  if (
    state.authority?.enabled !== true ||
    state.authority?.version !== ACTION_VERSION ||
    state.authority?.audience !== ACTION_AUDIENCE ||
    state.authority?.source?.repository !== REPOSITORY ||
    state.authority?.deployment?.space !== SPACE ||
    state.authority?.deployment?.revision !== hfRevision ||
    state.authority?.externalOperator !== true ||
    state.authority?.keyId !== trust.keyId ||
    state.authority?.trustEpoch !== trust.trustEpoch ||
    !INSTANCE_PATTERN.test(String(state.authority?.instanceId ?? "")) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    Number(state.authorityReceiptCount) !== revision ||
    (revision === 0 && rawHash !== null) ||
    (revision > 0 && !DIGEST_PATTERN.test(receiptHash)) ||
    state.authority?.durability?.required !== true ||
    state.authority?.durability?.verified !== true ||
    !durabilityPath.startsWith("/data/immune")
  ) {
    throw new Error("live action authority identity, receipt head, or durability is invalid");
  }
  return {
    instanceId: String(state.authority.instanceId),
    revision,
    receiptHash,
    evidenceState: String(state.evidenceState ?? ""),
    durabilityPath,
    deploymentRevision: hfRevision,
  };
}

async function observe(
  githubToken: string,
  hfToken: string,
  expectedSource: string,
  expectedPublicKey: string,
  expectedTrustEpoch: string,
): Promise<Discovery> {
  if ((await currentMain(githubToken)) !== expectedSource) {
    throw new Error("protected main does not match the admitted workflow source");
  }
  const authorization = hfHeaders(hfToken);
  const info = await json(HF_API, { headers: authorization });
  const hfRevision = String(info.sha ?? "").toLowerCase();
  if (
    info.id !== SPACE ||
    !REVISION_PATTERN.test(hfRevision) ||
    info.runtime?.stage !== "RUNNING" ||
    String(info.runtime?.sha ?? "").toLowerCase() !== hfRevision
  ) {
    throw new Error("Hugging Face provider state is not exact and RUNNING");
  }
  const runtime = await json(`${HF_API}/runtime`, { headers: authorization });
  if (
    runtime.stage !== "RUNNING" ||
    String(runtime.sha ?? "").toLowerCase() !== hfRevision
  ) {
    throw new Error("Hugging Face runtime endpoint disagrees with repository state");
  }
  const volume = writableAuthorityVolume(runtime);
  const base = `https://huggingface.co/spaces/${SPACE}/resolve/${hfRevision}/`;
  const manifestResponse = await response(base + "hf-deploy-manifest.json", {
    headers: authorization,
  });
  if (manifestResponse.status !== 200 || !manifestResponse.json) {
    throw new Error("immutable Hugging Face deploy manifest is unavailable");
  }
  const manifest = manifestResponse.json;
  if (
    manifest.schema !== "szl.hf-deploy-manifest/v2" ||
    manifest.source?.repository !== REPOSITORY ||
    manifest.source?.revision !== expectedSource ||
    manifest.source?.ref !== "refs/heads/main" ||
    manifest.destination?.repo_id !== SPACE ||
    manifest.destination?.repo_type !== "space" ||
    manifest.workflow?.repository !== REPOSITORY ||
    manifest.workflow?.ref !== "refs/heads/main" ||
    manifest.claims?.github_actions_provenance_verified !== false ||
    manifest.claims?.cryptographic_release_receipt !== false
  ) {
    throw new Error("immutable Hugging Face manifest source binding is invalid");
  }
  const deployRunId = Number(manifest.workflow?.run_id);
  const deployRunAttempt = Number(manifest.workflow?.run_attempt);
  if (
    !Number.isSafeInteger(deployRunId) ||
    deployRunId < 1 ||
    !Number.isSafeInteger(deployRunAttempt) ||
    deployRunAttempt < 1
  ) {
    throw new Error("immutable deploy workflow run identity is malformed");
  }
  const siblings = new Set(
    Array.isArray(info.siblings)
      ? info.siblings.map((item: JsonObject) => String(item.rfilename ?? ""))
      : [],
  );
  const expectedPaths = exactRemotePaths(manifest);
  if (
    siblings.size !== expectedPaths.size ||
    [...expectedPaths].some((entry) => !siblings.has(entry))
  ) {
    throw new Error("Hugging Face repository output set is not the exact whitelist");
  }
  const copiedManifest = await response(base + "dist/hf-deploy-manifest.json", {
    headers: authorization,
  });
  if (
    copiedManifest.status !== 200 ||
    sha256(copiedManifest.bytes) !== sha256(manifestResponse.bytes)
  ) {
    throw new Error("immutable Hugging Face manifest copies do not match");
  }
  for (const [artifactPath, expectedDigest] of Object.entries(manifest.artifacts)) {
    const artifact = await response(base + `dist/${artifactPath}`, {
      headers: authorization,
    });
    if (artifact.status !== 200 || sha256(artifact.bytes) !== expectedDigest) {
      throw new Error(`immutable Hugging Face artifact mismatch: ${artifactPath}`);
    }
  }
  const trustResponse = await response(base + "dist/immune-action-trust.json", {
    headers: authorization,
  });
  if (trustResponse.status !== 200 || !trustResponse.json) {
    throw new Error("immutable action trust artifact is unavailable");
  }
  const trust = parseActionTrustDocument(trustResponse.json);
  const publicRaw = canonicalRawPublicKey(expectedPublicKey);
  if (
    !trust.configured ||
    trust.publicKeyB64 !== expectedPublicKey ||
    trust.trustEpoch !== expectedTrustEpoch ||
    trust.keyId !== sha256(publicRaw).slice(0, 16)
  ) {
    throw new Error("immutable action trust artifact does not match owner inputs");
  }
  assertAuthorityVolumeMatchesTrust(volume, trust);
  const run = await json(
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${deployRunId}`,
    { headers: githubHeaders(githubToken) },
  );
  if (
    Number(run.id) !== deployRunId ||
    Number(run.run_attempt) !== deployRunAttempt ||
    run.path !== DEPLOY_WORKFLOW ||
    String(run.head_sha ?? "").toLowerCase() !== expectedSource ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !["push", "workflow_dispatch"].includes(run.event)
  ) {
    throw new Error("GitHub deploy run is not terminal exact-source success");
  }
  const build = await json(`${RUNTIME}/api/build-info`);
  if (
    build.schema !== "szl.build-info/v2" ||
    build.state !== "OBSERVED_HASH_MATCH" ||
    build.source_repository !== REPOSITORY ||
    build.source_revision !== expectedSource ||
    build.expected_huggingface_revision !== hfRevision ||
    build.observed_huggingface_revision !== hfRevision ||
    build.runtime_hash_match !== true ||
    build.receipt_minted !== false
  ) {
    throw new Error("live build is not exact-source and runtime-hash bound");
  }
  const state = await json(`${RUNTIME}/api/immune/state`);
  if (state.authority?.source?.revision !== expectedSource) {
    throw new Error("live action authority source does not match protected main");
  }
  const authority = parseAuthorityHead(state, trust, hfRevision);
  const readiness = await json(`${RUNTIME}/readyz`, {}, [200, 503]);
  const evidenceLedger = assertVerifiedEvidenceLedger(readiness.ledger);
  if (
    readiness.schema !== "szl.immune-readiness/v1" ||
    readiness.runtime_ready !== true ||
    readiness.read_ready !== true ||
    readiness.source?.repository !== REPOSITORY ||
    readiness.source?.revision !== expectedSource ||
    readiness.source?.build_revision !== expectedSource ||
    readiness.build?.state !== "OBSERVED_HASH_MATCH" ||
    readiness.runtime?.artifact_integrity?.status !== "MATCH" ||
    readiness.ledger?.ok !== true ||
    readiness.authority?.enabled !== true ||
    readiness.authority?.key_id !== trust.keyId ||
    readiness.authority?.source_revision !== expectedSource ||
    readiness.authority?.deployment?.space !== SPACE ||
    readiness.authority?.deployment?.revision !== hfRevision ||
    readiness.authority?.durability?.required !== true ||
    readiness.authority?.durability?.verified !== true
  ) {
    throw new Error("live runtime is not exact-source read-ready with durable authority");
  }
  if ((await currentMain(githubToken)) !== expectedSource) {
    throw new Error("protected main drifted during authority discovery");
  }
  return {
    schema: "szl.immune-authority-discovery/v1",
    sourceRevision: expectedSource,
    hfRevision,
    deployRunId,
    deployRunAttempt,
    manifestSha256: sha256(manifestResponse.bytes),
    outputPaths: [...siblings].sort(),
    volume,
    trust: {
      publicKeyB64: trust.publicKeyB64,
      publicKeySha256: sha256(publicRaw),
      keyId: trust.keyId,
      trustEpoch: trust.trustEpoch,
    },
    authority,
    ledger: evidenceLedger,
  };
}

function parseDiscovery(value: JsonObject): Discovery {
  assertVerifiedEvidenceLedger(value.ledger);
  if (
    value.schema !== "szl.immune-authority-discovery/v1" ||
    !REVISION_PATTERN.test(value.sourceRevision) ||
    !REVISION_PATTERN.test(value.hfRevision) ||
    !Number.isSafeInteger(value.deployRunId) ||
    value.deployRunId < 1 ||
    !Number.isSafeInteger(value.deployRunAttempt) ||
    value.deployRunAttempt < 1 ||
    !DIGEST_PATTERN.test(value.manifestSha256) ||
    !Array.isArray(value.outputPaths) ||
    value.outputPaths.some((entry: unknown) => typeof entry !== "string") ||
    value.volume?.type !== "bucket" ||
    typeof value.volume?.source !== "string" ||
    value.volume?.mountPath !== "/data" ||
    value.volume?.readOnly !== false ||
    !KEY_ID_PATTERN.test(value.trust?.keyId) ||
    !EPOCH_PATTERN.test(value.trust?.trustEpoch) ||
    !DIGEST_PATTERN.test(value.trust?.publicKeySha256) ||
    !INSTANCE_PATTERN.test(value.authority?.instanceId) ||
    !REVISION_PATTERN.test(value.authority?.deploymentRevision) ||
    !Number.isSafeInteger(value.authority?.revision) ||
    value.authority.revision < 0
  ) {
    throw new Error("saved authority discovery is malformed");
  }
  return value as Discovery;
}

function sameImmutableDiscovery(saved: Discovery, current: Discovery): void {
  const immutable = (value: Discovery) => ({
    sourceRevision: value.sourceRevision,
    hfRevision: value.hfRevision,
    deployRunId: value.deployRunId,
    deployRunAttempt: value.deployRunAttempt,
    manifestSha256: value.manifestSha256,
    outputPaths: value.outputPaths,
    volume: value.volume,
    trust: value.trust,
    authorityInstanceId: value.authority.instanceId,
    durabilityPath: value.authority.durabilityPath,
    deploymentRevision: value.authority.deploymentRevision,
    evidenceDurability: value.ledger.durability,
  });
  if (
    canonicalBytes(immutable(saved)).compare(canonicalBytes(immutable(current))) !==
    0
  ) {
    throw new Error("immutable deploy/provider discovery drifted");
  }
}

async function verifyReleaseReceipt(
  rawReceipt: JsonObject,
  receipt: ReleaseReceipt,
  observation: Discovery,
  hfToken: string,
): Promise<void> {
  if (process.env.IMMUNE_RELEASE_ATTESTATION_VERIFIED !== "1") {
    throw new Error("GitHub artifact attestation verification was not witnessed");
  }
  if (
    receipt.repository !== REPOSITORY ||
    receipt.source_revision !== observation.sourceRevision ||
    Number(receipt.workflow.run_id) !== observation.deployRunId ||
    Number(receipt.workflow.run_attempt) !== observation.deployRunAttempt ||
    receipt.hf.space !== SPACE ||
    receipt.hf.revision !== observation.hfRevision ||
    receipt.manifest.sha256 !== observation.manifestSha256 ||
    receipt.volume.type !== observation.volume.type ||
    receipt.volume.source !== observation.volume.source ||
    receipt.volume.mount_path !== observation.volume.mountPath ||
    receipt.volume.read_only !== observation.volume.readOnly ||
    receipt.trust.key_id !== observation.trust.keyId ||
    receipt.trust.trust_epoch !== observation.trust.trustEpoch ||
    receipt.trust.public_key_sha256 !== observation.trust.publicKeySha256 ||
    receipt.authority.instance_id !== observation.authority.instanceId ||
    canonicalBytes(receipt.ledger.durability).compare(canonicalBytes(observation.ledger.durability)) !== 0 ||
    receipt.ledger.count > observation.ledger.count ||
    receipt.authority.durability.required !== true ||
    receipt.authority.durability.verified !== true ||
    receipt.authority.durability.path !== observation.authority.durabilityPath ||
    receipt.authority.revision > observation.authority.revision ||
    (receipt.authority.revision === observation.authority.revision &&
      receipt.authority.receipt_hash !== observation.authority.receiptHash)
  ) {
    throw new Error("attested release receipt does not match the live immutable deployment");
  }
  const receiptPaths = receipt.outputs.files.map((entry) => entry.path);
  if (
    canonicalBytes(receiptPaths).compare(canonicalBytes(observation.outputPaths)) !==
    0
  ) {
    throw new Error("attested release receipt output set differs from provider inventory");
  }
  const base =
    `https://huggingface.co/spaces/${SPACE}/resolve/${observation.hfRevision}/`;
  for (const output of receipt.outputs.files) {
    const artifact = await response(base + output.path, {
      headers: hfHeaders(hfToken),
    });
    if (artifact.status !== 200 || sha256(artifact.bytes) !== output.sha256) {
      throw new Error(`attested release output mismatch: ${output.path}`);
    }
  }
  if (
    canonicalBytes(parseReleaseReceipt(rawReceipt)).compare(
      canonicalBytes(receipt),
    ) !== 0
  ) {
    throw new Error("release receipt changed during strict parsing");
  }
}

function parseModeInputs(cleanup: boolean): {
  action: ImmuneAction;
  leaseMinutes: number;
} {
  if (cleanup) {
    return {
      action: { type: "SET_MODE", mode: "SENTRA_REJECT" },
      leaseMinutes: 5,
    };
  }
  const mode = required("INPUT_MODE");
  if (!["PASS", "SENTRA_REJECT", "DEADMAN"].includes(mode)) {
    throw new Error("INPUT_MODE is invalid");
  }
  const tripwire = process.env.INPUT_TRIPWIRE?.trim() || null;
  if (
    mode === "DEADMAN"
      ? !tripwire || !TRIPWIRE_PATTERN.test(tripwire)
      : tripwire !== null
  ) {
    throw new Error("tripwire must be T01-T10 for DEADMAN and empty otherwise");
  }
  const leaseMinutes = Number(required("INPUT_LEASE_MINUTES"));
  if (
    !Number.isSafeInteger(leaseMinutes) ||
    leaseMinutes < 5 ||
    leaseMinutes > (mode === "PASS" ? 15 : 1440)
  ) {
    throw new Error("lease is outside the mode-specific authority limit");
  }
  return {
    action: {
      type: "SET_MODE",
      mode: mode as ImmuneAction["mode"],
      ...(mode === "DEADMAN" ? { tripwire: tripwire! } : {}),
    },
    leaseMinutes,
  };
}

function assertExplicitHead(observation: Discovery): void {
  const expectedInstance = required("INPUT_EXPECTED_AUTHORITY_INSTANCE_ID");
  const expectedRevisionText = required("INPUT_EXPECTED_REVISION");
  const expectedHash = required("INPUT_EXPECTED_RECEIPT_HASH");
  if (
    !INSTANCE_PATTERN.test(expectedInstance) ||
    !/^(0|[1-9][0-9]*)$/u.test(expectedRevisionText) ||
    !Number.isSafeInteger(Number(expectedRevisionText)) ||
    (Number(expectedRevisionText) === 0
      ? expectedHash !== "GENESIS"
      : !DIGEST_PATTERN.test(expectedHash)) ||
    expectedInstance !== observation.authority.instanceId ||
    Number(expectedRevisionText) !== observation.authority.revision ||
    expectedHash !== observation.authority.receiptHash
  ) {
    throw new Error("explicit authority head inputs do not match the live durable head");
  }
}

async function discover(outputFile: string): Promise<void> {
  const source = required("GITHUB_SHA").toLowerCase();
  if (
    required("GITHUB_REPOSITORY").toLowerCase() !== REPOSITORY ||
    required("GITHUB_REF") !== "refs/heads/main" ||
    !REVISION_PATTERN.test(source)
  ) {
    throw new Error("authority workflow source binding is invalid");
  }
  const observation = await observe(
    required("GITHUB_TOKEN"),
    required("HF_TOKEN"),
    source,
    required("IMMUNE_ACTION_PUBLIC_KEY"),
    required("IMMUNE_ACTION_TRUST_EPOCH"),
  );
  writeExclusive(outputFile, observation);
  fs.appendFileSync(
    required("GITHUB_OUTPUT"),
    `deploy_run_id=${observation.deployRunId}\nhf_revision=${observation.hfRevision}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({
      schema: observation.schema,
      sourceRevision: observation.sourceRevision,
      hfRevision: observation.hfRevision,
      deployRunId: observation.deployRunId,
      keyId: observation.trust.keyId,
      authorityInstanceId: observation.authority.instanceId,
      authorityRevision: observation.authority.revision,
      authorityReceiptHash: observation.authority.receiptHash,
    }),
  );
}

async function prepare(
  discoveryFile: string,
  receiptFile: string,
  outputFile: string,
  cleanup: boolean,
): Promise<void> {
  const saved = parseDiscovery(readObject(discoveryFile, "authority discovery"));
  const githubToken = required("GITHUB_TOKEN");
  const hfToken = required("HF_TOKEN");
  const current = await observe(
    githubToken,
    hfToken,
    saved.sourceRevision,
    required("IMMUNE_ACTION_PUBLIC_KEY"),
    required("IMMUNE_ACTION_TRUST_EPOCH"),
  );
  sameImmutableDiscovery(saved, current);
  const rawReceipt = readObject(receiptFile, "attested release receipt");
  const receipt = parseReleaseReceipt(rawReceipt);
  await verifyReleaseReceipt(rawReceipt, receipt, current, hfToken);
  if (!cleanup) assertExplicitHead(current);
  const { action, leaseMinutes } = parseModeInputs(cleanup);
  const now = new Date();
  const unsigned = parseUnsignedEnvelope({
    version: ACTION_VERSION,
    requestId: `${cleanup ? "failclosed" : "owner"}-${saved.sourceRevision.slice(0, 12)}-${crypto.randomUUID()}`,
    trustEpoch: current.trust.trustEpoch,
    authorityInstanceId: current.authority.instanceId,
    expectedRevision: current.authority.revision,
    expectedReceiptHash: current.authority.receiptHash,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
    validUntil: new Date(now.getTime() + leaseMinutes * 60_000).toISOString(),
    actor: `github:${required("GITHUB_ACTOR")}`,
    keyId: current.trust.keyId,
    audience: ACTION_AUDIENCE,
    source: { repository: REPOSITORY, revision: saved.sourceRevision },
    deployment: { space: SPACE, revision: saved.hfRevision },
    action,
  });
  writeExclusive(outputFile, unsigned);
  console.log(
    JSON.stringify({
      schema: cleanup
        ? "szl.immune-authority-cleanup-intent/v1"
        : "szl.immune-authority-intent/v1",
      requestId: unsigned.requestId,
      source: unsigned.source,
      action: unsigned.action,
      authorityInstanceId: unsigned.authorityInstanceId,
      expectedRevision: unsigned.expectedRevision,
      expectedReceiptHash: unsigned.expectedReceiptHash,
      expiresAt: unsigned.expiresAt,
      validUntil: unsigned.validUntil,
    }),
  );
}

function verifyEnvelopeAgainstIntent(
  intent: UnsignedActionEnvelope,
  envelope: SignedActionEnvelope,
  publicKeyB64: string,
): void {
  if (
    canonicalBytes(intent).compare(canonicalBytes(unsignedEnvelope(envelope))) !==
    0
  ) {
    throw new Error("signed envelope differs from the preflighted unsigned intent");
  }
  const raw = canonicalRawPublicKey(publicKeyB64);
  if (sha256(raw).slice(0, 16) !== envelope.keyId) {
    throw new Error("signed envelope keyId differs from the public trust pin");
  }
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  if (
    !crypto.verify(
      null,
      canonicalBytes(intent),
      key,
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    throw new Error("offline signer output does not verify against the public trust pin");
  }
}

async function pollExactReceipt(
  envelope: SignedActionEnvelope,
  postStatus: number | null,
  postFailure: unknown,
): Promise<JsonObject> {
  const digest = envelopeDigest(envelope);
  const url =
    `${RUNTIME}/api/immune/state/receipts/${encodeURIComponent(envelope.requestId)}` +
    `?envelopeDigest=${digest}`;
  const deadline = Date.parse(envelope.expiresAt);
  let last = postFailure;
  while (Date.now() <= deadline) {
    try {
      const lookup = await response(url);
      if (lookup.status === 200 && lookup.json?.receipt) {
        const receipt = lookup.json.receipt as JsonObject;
        if (
          receipt.requestId !== envelope.requestId ||
          receipt.envelopeDigest !== digest ||
          canonicalBytes(receipt.envelope).compare(canonicalBytes(envelope)) !== 0
        ) {
          throw new Error("receipt lookup returned a different signed envelope");
        }
        return receipt;
      }
      if (![404, 409, 503].includes(lookup.status)) {
        last = new Error(`receipt lookup returned HTTP ${lookup.status}`);
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `signed action was not reconciled through its admission window after POST ${postStatus ?? "unknown"}: ${String(last ?? "receipt absent")}`,
  );
}

async function submit(
  discoveryFile: string,
  receiptFile: string,
  intentFile: string,
  envelopeFile: string,
  evidenceFile: string,
): Promise<void> {
  const saved = parseDiscovery(readObject(discoveryFile, "authority discovery"));
  const intent = parseUnsignedEnvelope(
    readObject(intentFile, "unsigned authority intent"),
  );
  const envelope = parseSignedEnvelope(
    readObject(envelopeFile, "signed authority envelope"),
  );
  verifyEnvelopeAgainstIntent(
    intent,
    envelope,
    required("IMMUNE_ACTION_PUBLIC_KEY"),
  );
  const githubToken = required("GITHUB_TOKEN");
  const hfToken = required("HF_TOKEN");
  const before = await observe(
    githubToken,
    hfToken,
    saved.sourceRevision,
    required("IMMUNE_ACTION_PUBLIC_KEY"),
    required("IMMUNE_ACTION_TRUST_EPOCH"),
  );
  sameImmutableDiscovery(saved, before);
  const rawReceipt = readObject(receiptFile, "attested release receipt");
  await verifyReleaseReceipt(
    rawReceipt,
    parseReleaseReceipt(rawReceipt),
    before,
    hfToken,
  );
  if (
    before.authority.instanceId !== envelope.authorityInstanceId ||
    before.authority.revision !== envelope.expectedRevision ||
    before.authority.receiptHash !== envelope.expectedReceiptHash
  ) {
    throw new Error("authority head changed after offline signing; POST was not attempted");
  }
  const digest = envelopeDigest(envelope);
  console.log(
    JSON.stringify({
      schema: "szl.immune-action-intent/v2",
      requestId: envelope.requestId,
      envelopeDigest: digest,
      action: envelope.action,
      source: envelope.source,
      expectedRevision: envelope.expectedRevision,
      expectedReceiptHash: envelope.expectedReceiptHash,
    }),
  );
  let postStatus: number | null = null;
  let postFailure: unknown = null;
  try {
    const posted = await response(`${RUNTIME}/api/immune/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    postStatus = posted.status;
    if (![201, 409].includes(postStatus)) {
      postFailure = new Error(`action POST returned HTTP ${postStatus}`);
    }
  } catch (error) {
    postFailure = error;
  }
  // Do not retry this mutation. Read back the one immutable request+digest
  // until its signed admission window has closed.
  const receipt = await pollExactReceipt(envelope, postStatus, postFailure);
  const state = await json(`${RUNTIME}/api/immune/state`);
  const readiness = await json(`${RUNTIME}/readyz`, {}, [200, 503]);
  assertExactAppliedAction(envelope, receipt, state, readiness);
  const after = await observe(
    githubToken,
    hfToken,
    saved.sourceRevision,
    required("IMMUNE_ACTION_PUBLIC_KEY"),
    required("IMMUNE_ACTION_TRUST_EPOCH"),
  );
  sameImmutableDiscovery(saved, after);
  if (
    after.authority.revision !== envelope.expectedRevision + 1 ||
    after.authority.receiptHash !== receipt.receiptHash
  ) {
    throw new Error("post-action authority head does not match the exact receipt");
  }
  const evidence = {
    schema: "szl.immune-authority-action-evidence/v3",
    sourceRevision: saved.sourceRevision,
    hfRevision: saved.hfRevision,
    deployRunId: saved.deployRunId,
    requestId: envelope.requestId,
    envelopeDigest: digest,
    action: envelope.action,
    authorityInstanceId: envelope.authorityInstanceId,
    receipt: {
      seq: receipt.seq,
      hash: receipt.receiptHash,
      previousHash: receipt.previousHash,
    },
    readiness: {
      status: readiness.status,
      ready: readiness.ready,
      write_ready: readiness.write_ready,
      blockers: readiness.blockers,
      ledger: assertVerifiedEvidenceLedger(readiness.ledger),
    },
    signedEnvelope: envelope,
    appliedReceipt: receipt,
  };
  writeExclusive(evidenceFile, evidence);
  console.log(
    JSON.stringify({
      schema: evidence.schema,
      sourceRevision: evidence.sourceRevision,
      hfRevision: evidence.hfRevision,
      deployRunId: evidence.deployRunId,
      requestId: evidence.requestId,
      envelopeDigest: evidence.envelopeDigest,
      action: evidence.action,
      authorityInstanceId: evidence.authorityInstanceId,
      receipt: evidence.receipt,
      readiness: evidence.readiness,
      signedEnvelope: "retained-in-evidence-artifact",
      appliedReceipt: "retained-in-evidence-artifact",
    }),
  );
}

async function main(): Promise<void> {
  const [command, ...files] = process.argv.slice(2);
  if (command === "discover" && files.length === 1) {
    await discover(files[0]);
    return;
  }
  if (
    (command === "prepare" || command === "prepare-reject") &&
    files.length === 3
  ) {
    await prepare(files[0], files[1], files[2], command === "prepare-reject");
    return;
  }
  if (command === "submit" && files.length === 5) {
    await submit(files[0], files[1], files[2], files[3], files[4]);
    return;
  }
  throw new Error(
    "usage: immune-authority-action.ts discover <discovery> | prepare[-reject] <discovery> <release-receipt> <intent> | submit <discovery> <release-receipt> <intent> <envelope> <evidence>",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
