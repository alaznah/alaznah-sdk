export type ActiveCallRecoverySnapshot = {
  callId: string;
  state: string;
  mediaConnectedOnce?: boolean;
  pcState?: string;
  iceState?: string;
};

export type RecoveryAction = 'none' | 'schedule-ice' | 'recover-now';

/**
 * Decide silent recovery after signaling reconnect or network restore.
 * Never surfaces errors to the SDK user — caller applies action quietly.
 */
export function decideCallRecovery(
  call: ActiveCallRecoverySnapshot | null | undefined,
): RecoveryAction {
  if (!call?.mediaConnectedOnce) return 'none';
  if (call.state !== 'connected' && call.state !== 'reconnecting' && call.state !== 'accepted') {
    return 'none';
  }

  const pc = call.pcState;
  const ice = call.iceState;

  if (pc === 'failed' || ice === 'failed' || call.state === 'reconnecting') {
    return 'recover-now';
  }
  if (pc === 'disconnected' || ice === 'disconnected') {
    return 'schedule-ice';
  }
  return 'none';
}
