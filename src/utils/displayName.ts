/** Shown when signaling did not include a peer display name (never fall back to raw user id). */
export const UNKNOWN_PEER_LABEL = 'Unknown caller';

export function requireDisplayName(value: string | undefined, fieldLabel: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${fieldLabel} is required`);
  }
  return trimmed;
}

export function resolvePeerDisplayName(
  peerDisplayName?: string,
  participantDisplayName?: string,
): string {
  return (
    peerDisplayName?.trim() ||
    participantDisplayName?.trim() ||
    UNKNOWN_PEER_LABEL
  );
}
