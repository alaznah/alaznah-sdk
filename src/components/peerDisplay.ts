import type { ActiveCall } from '../types/index.js';

/** Prefer peer display name; never crash on empty. */
export function getPeerDisplayName(call: ActiveCall): string {
  const fromField = call.peerDisplayName?.trim();
  if (fromField) return fromField;
  const fromParticipants = call.participants
    ?.find((p) => p.participantId === call.peerId)
    ?.displayName?.trim();
  if (fromParticipants) return fromParticipants;
  return call.peerId;
}

export function getPeerInitials(call: ActiveCall): string {
  const label = getPeerDisplayName(call);
  const parts = label
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  }
  return (parts[0] ?? label).slice(0, 2).toUpperCase();
}

export function isRemoteMuted(call: ActiveCall): boolean {
  if (typeof call.remoteMuted === 'boolean') return call.remoteMuted;
  return Boolean(call.participants?.find((p) => p.participantId === call.peerId)?.muted);
}
