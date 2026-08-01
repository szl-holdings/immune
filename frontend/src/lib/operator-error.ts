export const OPERATOR_ERROR_SUMMARY_MAX_LENGTH = 240;

const FALLBACK_OPERATOR_ERROR = "Request failed without a usable error message.";
const SECRET_ASSIGNMENT =
  /\b(authorization|bearer|cookie|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi;

export function summarizeOperatorError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : FALLBACK_OPERATOR_ERROR;
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || FALLBACK_OPERATOR_ERROR).slice(
    0,
    OPERATOR_ERROR_SUMMARY_MAX_LENGTH,
  );
}
