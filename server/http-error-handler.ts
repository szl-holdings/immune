import type { NextFunction, Request, Response } from "express";

// Accept only known body-parser client-error types with their expected status.
// Error text, request bodies and stacks must never enter the public response.
function publicBodyError(err: unknown): { status: number; error: string } | null {
  if (!(err instanceof Error)) return null;
  const bodyError = err as Error & { type?: unknown; status?: unknown };
  switch (bodyError.type) {
    case "entity.parse.failed":
    case "request.aborted":
    case "request.size.invalid":
      return bodyError.status === 400
        ? { status: 400, error: "invalid request body" }
        : null;
    case "entity.too.large":
      return bodyError.status === 413
        ? { status: 413, error: "request body too large" }
        : null;
    case "charset.unsupported":
    case "encoding.unsupported":
      return bodyError.status === 415
        ? { status: 415, error: "unsupported request body encoding" }
        : null;
    default:
      return null;
  }
}

export function publicHttpErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const response = publicBodyError(err);
  res.status(response?.status ?? 500).json({ error: response?.error ?? "internal error" });
}
