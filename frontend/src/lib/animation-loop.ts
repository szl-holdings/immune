export type RequestFrame = (callback: (timestamp: number) => void) => number;
export type CancelFrame = (frameId: number) => void;

/** Start one cancellable frame loop. Cleanup is idempotent and prevents a
 * callback that was already queued from scheduling another frame. */
export function startAnimationLoop(
  onFrame: (timestamp: number) => void,
  requestFrame: RequestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame: CancelFrame = (frameId) => window.cancelAnimationFrame(frameId),
): () => void {
  let active = true;
  let frameId: number | null = null;
  const tick = (timestamp: number) => {
    if (!active) return;
    onFrame(timestamp);
    if (active) frameId = requestFrame(tick);
  };
  frameId = requestFrame(tick);
  return () => {
    if (!active) return;
    active = false;
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
  };
}
