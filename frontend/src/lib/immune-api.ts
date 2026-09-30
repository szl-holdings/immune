import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";
export type EvidenceState = "VERIFIED" | "FAILED" | "UNAVAILABLE" | "STALE";

export interface SignedActionEnvelope {
  version: "immune.action.v2";
  requestId: string;
  trustEpoch: string;
  authorityInstanceId: string;
  expectedRevision: number;
  expectedReceiptHash: "GENESIS" | string;
  issuedAt: string;
  expiresAt: string;
  validUntil: string;
  actor: string;
  keyId: string;
  audience: "hf-space:SZLHOLDINGS/immune";
  source: {
    repository: "szl-holdings/immune";
    revision: string;
  };
  deployment: {
    space: "SZLHOLDINGS/immune";
    revision: string;
  };
  action:
    | { type: "SET_MODE"; mode: ImmuneMode; tripwire?: string | null }
    | { type: "RESET" };
  signature: string;
}

export interface AuthoritativeTripwireState {
  evidenceState: EvidenceState;
  mode: ImmuneMode;
  deadman: boolean;
  tripwire: string | null;
  reason: string;
  validUntil: string | null;
  updatedAt: string | null;
  requestId: string | null;
  revision: number;
}

export interface ImmuneState {
  mode: ImmuneMode;
  tripwire: string | null;
  deadman: boolean;
  ledgerCount: number;
  lastHash: string | null;
  evidenceState: EvidenceState;
  reason: string;
  validUntil: string | null;
  updatedAt: string | null;
  requestId: string | null;
  revision: number;
  authorityReceiptCount: number;
  authorityReceiptHash: string | null;
  authority: {
    enabled: boolean;
    version: "immune.action.v2";
    keyId: string | null;
    trustEpoch: string | null;
    instanceId: string | null;
    audience: "hf-space:SZLHOLDINGS/immune";
    source: {
      repository: "szl-holdings/immune";
      revision: string | null;
    };
    deployment: {
      space: "SZLHOLDINGS/immune";
      revision: string | null;
    };
    durability: {
      required: boolean;
      verified: boolean;
      path: string;
    };
    externalOperator: true;
  };
  durableState: {
    mode: ImmuneMode;
    tripwire: string | null;
    deadman: boolean;
    updatedAt: string | null;
    requestId: string | null;
    revision: number;
  };
  tripwireState: AuthoritativeTripwireState;
}

declare global {
  interface Window {
    __IMMUNE_BOOTSTRAP__?: ImmuneState;
  }
}

export interface ImmuneReceipt {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
  payload: Record<string, unknown>;
  alg?: "ed25519";
  sig?: string;
  pub?: string;
  kid?: string;
}

export interface LedgerLatest {
  count: number;
  entries: ImmuneReceipt[];
}

export interface VerifierIssue {
  seq: number;
  kind: string;
  detail: string;
}

export interface VerifierReport {
  ok: boolean;
  count: number;
  issues: VerifierIssue[];
  firstBadSeq: number | null;
}

export interface ImmuneReadiness {
  schema: "szl.immune-readiness/v1";
  status: "READY" | "READ_ONLY" | "NOT_READY";
  ready: boolean;
  runtime_ready: boolean;
  read_ready: boolean;
  authority_ready: boolean;
  write_ready: boolean;
  blockers: string[];
  source: {
    repository: string | null;
    revision: string | null;
    build_revision: string | null;
    alignment_state: string;
    manifest_schema: string | null;
  };
  build: {
    state: string;
    artifact_count: number;
    runtime_hash_match: boolean;
    artifact_set_algorithm: "sha256(json(sorted[path,sha256]))";
    deployment_manifest_sha256: string | null;
    artifact_set_sha256: string | null;
  };
  runtime: {
    immune_server_sha256: string | null;
    public_index_sha256: string | null;
    artifact_integrity: {
      status: string;
      checked: number;
      failures: unknown[];
    };
  };
  ledger: {
    ok: boolean;
    count: number;
    first_bad_seq: number | null;
    durability: { required: true; verified: boolean; path: string; mount_path: "/data"; reason: string };
  };
  authority: {
    enabled: boolean;
    evidence_state: EvidenceState;
    key_id: string | null;
    version: "immune.action.v2";
    audience: "hf-space:SZLHOLDINGS/immune";
    source_revision: string | null;
    deployment: {
      space: "SZLHOLDINGS/immune";
      revision: string | null;
    };
    external_operator: boolean;
    receipt_count: number;
    receipt_hash: string | null;
    durability: {
      required: boolean;
      verified: boolean;
      path: string | null;
    };
  };
}

export interface ImmuneCycleResult {
  pass: boolean;
  mode: ImmuneMode;
  deadman: boolean;
  sentra: Record<string, unknown>;
  huklla: Array<Record<string, unknown>>;
  receipt: ImmuneReceipt | null;
  ledgerCount: number;
  lastHash: string | null;
}

interface DataEnvelope<T> {
  data: T;
}

const siteBase = import.meta.env?.BASE_URL || "/";
const normalizedSiteBase = siteBase.endsWith("/") ? siteBase : `${siteBase}/`;
const apiBase = `${normalizedSiteBase}api/immune`;
const readinessUrl = `${normalizedSiteBase}readyz`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseImmuneReadiness(value: unknown): ImmuneReadiness {
  if (!isRecord(value)) throw new Error("IMMUNE readiness body is not an object");
  const source = value.source;
  const build = value.build;
  const runtime = value.runtime;
  const ledger = value.ledger;
  const authority = value.authority;
  if (
    value.schema !== "szl.immune-readiness/v1" ||
    !["READY", "READ_ONLY", "NOT_READY"].includes(String(value.status)) ||
    typeof value.ready !== "boolean" ||
    typeof value.runtime_ready !== "boolean" ||
    typeof value.read_ready !== "boolean" ||
    typeof value.authority_ready !== "boolean" ||
    typeof value.write_ready !== "boolean" ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every((item) => typeof item === "string") ||
    !isRecord(source) ||
    !isNullableString(source.repository) ||
    !isNullableString(source.revision) ||
    !isNullableString(source.build_revision) ||
    typeof source.alignment_state !== "string" ||
    !isNullableString(source.manifest_schema) ||
    !isRecord(build) ||
    typeof build.state !== "string" ||
    !isNonnegativeInteger(build.artifact_count) ||
    typeof build.runtime_hash_match !== "boolean" ||
    build.artifact_set_algorithm !== "sha256(json(sorted[path,sha256]))" ||
    !isNullableString(build.deployment_manifest_sha256) ||
    !isNullableString(build.artifact_set_sha256) ||
    !isRecord(runtime) ||
    !isNullableString(runtime.immune_server_sha256) ||
    !isNullableString(runtime.public_index_sha256) ||
    !isRecord(runtime.artifact_integrity) ||
    typeof runtime.artifact_integrity.status !== "string" ||
    !isNonnegativeInteger(runtime.artifact_integrity.checked) ||
    !Array.isArray(runtime.artifact_integrity.failures) ||
    !isRecord(ledger) ||
    typeof ledger.ok !== "boolean" ||
    !isNonnegativeInteger(ledger.count) ||
    !(ledger.first_bad_seq === null || isNonnegativeInteger(ledger.first_bad_seq)) ||
    !isRecord(ledger.durability) ||
    ledger.durability.required !== true ||
    typeof ledger.durability.verified !== "boolean" ||
    typeof ledger.durability.path !== "string" ||
    ledger.durability.mount_path !== "/data" ||
    typeof ledger.durability.reason !== "string" ||
    !isRecord(authority) ||
    typeof authority.enabled !== "boolean" ||
    !["VERIFIED", "FAILED", "UNAVAILABLE", "STALE"].includes(
      String(authority.evidence_state),
    ) ||
    !isNullableString(authority.key_id) ||
    authority.version !== "immune.action.v2" ||
    authority.audience !== "hf-space:SZLHOLDINGS/immune" ||
    !isNullableString(authority.source_revision) ||
    !isRecord(authority.deployment) ||
    authority.deployment.space !== "SZLHOLDINGS/immune" ||
    !isNullableString(authority.deployment.revision) ||
    typeof authority.external_operator !== "boolean" ||
    !isNonnegativeInteger(authority.receipt_count) ||
    !isNullableString(authority.receipt_hash) ||
    !isRecord(authority.durability) ||
    typeof authority.durability.required !== "boolean" ||
    typeof authority.durability.verified !== "boolean" ||
    !isNullableString(authority.durability.path)
  ) {
    throw new Error("IMMUNE readiness body does not match szl.immune-readiness/v1");
  }
  return value as unknown as ImmuneReadiness;
}

export async function fetchImmuneReadiness(
  fetchImpl: typeof fetch = fetch,
): Promise<ImmuneReadiness> {
  const response = await fetchImpl(readinessUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`IMMUNE readiness GET /readyz failed: HTTP ${response.status}`);
  }
  return parseImmuneReadiness(await response.json());
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `IMMUNE API ${init?.method ?? "GET"} ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

export const getGetImmuneStateQueryKey = () =>
  ["immune", "state"] as const;
export const getGetImmuneReadinessQueryKey = () =>
  ["immune", "readiness"] as const;
export const getGetImmuneLedgerLatestQueryKey = () =>
  ["immune", "ledger", "latest"] as const;
export const getVerifyImmuneLedgerQueryKey = () =>
  ["immune", "ledger", "verify"] as const;
export const getGetImmuneEvidenceLatestQueryKey = () =>
  ["immune", "evidence", "latest"] as const;

export function useGetImmuneState(): UseQueryResult<ImmuneState, Error> {
  const bootstrap =
    typeof window !== "undefined" ? window.__IMMUNE_BOOTSTRAP__ : undefined;
  return useQuery({
    queryKey: getGetImmuneStateQueryKey(),
    queryFn: () => request<ImmuneState>("/state"),
    refetchInterval: 5_000,
    initialData: bootstrap,
    initialDataUpdatedAt: bootstrap ? Date.now() : undefined,
  });
}

export function useGetImmuneReadiness(): UseQueryResult<ImmuneReadiness, Error> {
  return useQuery({
    queryKey: getGetImmuneReadinessQueryKey(),
    queryFn: () => fetchImmuneReadiness(),
    refetchInterval: 5_000,
  });
}

export function useGetImmuneLedgerLatest(): UseQueryResult<LedgerLatest, Error> {
  return useQuery({
    queryKey: getGetImmuneLedgerLatestQueryKey(),
    queryFn: () => request<LedgerLatest>("/ledger/latest"),
    refetchInterval: 5_000,
  });
}

export function useVerifyImmuneLedger(): UseQueryResult<VerifierReport, Error> {
  return useQuery({
    queryKey: getVerifyImmuneLedgerQueryKey(),
    queryFn: () => request<VerifierReport>("/ledger/verify"),
    refetchInterval: 10_000,
  });
}

export function useSubmitImmuneAction(): UseMutationResult<
  ImmuneState,
  Error,
  DataEnvelope<SignedActionEnvelope>
> {
  return useMutation({
    mutationFn: ({ data }) =>
      request<ImmuneState>("/state", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}

export function useRunImmuneCycle(): UseMutationResult<
  ImmuneCycleResult,
  Error,
  DataEnvelope<{ actor: string; intent: string }>
> {
  return useMutation({
    mutationFn: ({ data }) =>
      request<ImmuneCycleResult>("/cycle", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}
