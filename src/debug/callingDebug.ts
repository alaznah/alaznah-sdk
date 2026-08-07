/** Dev-only structured logs for kill-state / CallKit / push debugging. */
export function callingDebug(event: string, detail?: Record<string, unknown>): void {
  if (!__DEV__) return;
  if (detail) {
    console.log(`[CallingDebug] ${event}`, detail);
  } else {
    console.log(`[CallingDebug] ${event}`);
  }
}
