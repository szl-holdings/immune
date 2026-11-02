export type ReadinessClaim = {
  ready: boolean;
};

/**
 * Keep transport status and the parsed readiness claim inseparable.
 * A degraded response that carries a green body must never reach the UI as
 * admissible write evidence, and a nominal 200 must not hide a blocked body.
 */
export function assertReadinessHttpBinding(
  status: number,
  readiness: ReadinessClaim,
): void {
  const expectedStatus = readiness.ready ? 200 : 503;
  if (status !== expectedStatus) {
    throw new Error(
      `IMMUNE readiness HTTP ${status} contradicts parsed ready claim ${String(readiness.ready)}`,
    );
  }
}
