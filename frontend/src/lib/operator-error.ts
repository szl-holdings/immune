export const OPERATOR_ERROR_SUMMARY_MAX_LENGTH = 120;

const FALLBACK_OPERATOR_ERROR =
  "Request failed. No response detail is shown; verify the ledger before retrying.";
const IMMUNE_API_FAILURE =
  /^IMMUNE API ([A-Z]+) (\/[A-Za-z0-9/_-]{1,128}) failed: HTTP ([1-5][0-9]{2})(?:\s|$)/;

export function summarizeOperatorError(
  error: unknown,
  expected: { method: string; path: string },
): string {
  if (!(error instanceof Error)) return FALLBACK_OPERATOR_ERROR;
  const match = IMMUNE_API_FAILURE.exec(error.message);
  if (
    match === null ||
    match[1] !== expected.method ||
    match[2] !== expected.path
  ) {
    return FALLBACK_OPERATOR_ERROR;
  }
  return `IMMUNE API ${expected.method} ${expected.path} failed: HTTP ${match[3]}.`.slice(
    0,
    OPERATOR_ERROR_SUMMARY_MAX_LENGTH,
  );
}
