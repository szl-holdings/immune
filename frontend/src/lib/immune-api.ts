import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";
export type EvidenceState = "VERIFIED" | "FAILED" | "UNAVAILABLE" | "STALE";

export interface SignedActionEnvelope {
  version: "immune.action.v1";
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  actor: string;
  keyId: string;
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
    version: "immune.action.v1";
    keyId: string | null;
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

const apiBase = `${import.meta.env.BASE_URL || "/"}api/immune`;

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
export const getGetImmuneLedgerLatestQueryKey = () =>
  ["immune", "ledger", "latest"] as const;
export const getVerifyImmuneLedgerQueryKey = () =>
  ["immune", "ledger", "verify"] as const;
export const getGetImmuneEvidenceLatestQueryKey = () =>
  ["immune", "evidence", "latest"] as const;

export function useGetImmuneState(): UseQueryResult<ImmuneState, Error> {
  return useQuery({
    queryKey: getGetImmuneStateQueryKey(),
    queryFn: () => request<ImmuneState>("/state"),
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
  DataEnvelope<{ actor?: string; intent?: string }>
> {
  return useMutation({
    mutationFn: ({ data }) =>
      request<ImmuneCycleResult>("/cycle", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}
