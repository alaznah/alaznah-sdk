import type { ActiveCall, MediaStreamLike } from '../types/index.js';
import { resolvePeerDisplayName } from '../utils/displayName.js';

function initialsFromLabel(label: string): string {
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

function peerParticipant(call: ActiveCall) {
  return call.participants?.find((p) => p.participantId === call.peerId);
}

function localParticipant(call: ActiveCall) {
  return call.participants?.find((p) => p.participantId !== call.peerId);
}

/** Prefer peer display name; never show raw user id in default UI. */
export function getPeerDisplayName(call: ActiveCall): string {
  const fromField = call.peerDisplayName?.trim();
  const fromParticipants = peerParticipant(call)?.displayName?.trim();
  return resolvePeerDisplayName(fromField, fromParticipants);
}

export function getPeerInitials(call: ActiveCall): string {
  return initialsFromLabel(getPeerDisplayName(call));
}

export function getPeerAvatarUrl(call: ActiveCall): string | undefined {
  const url = peerParticipant(call)?.avatarUrl?.trim();
  return url && url.length > 0 ? url : undefined;
}

/** Local participant display name from the call roster (not the peer). */
export function getLocalDisplayName(call: ActiveCall, fallback = 'You'): string {
  const name = localParticipant(call)?.displayName?.trim();
  return name && name.length > 0 ? name : fallback;
}

export function getLocalInitials(call: ActiveCall): string {
  return initialsFromLabel(getLocalDisplayName(call));
}

export function getLocalAvatarUrl(call: ActiveCall): string | undefined {
  const url = localParticipant(call)?.avatarUrl?.trim();
  return url && url.length > 0 ? url : undefined;
}

export function isRemoteMuted(call: ActiveCall): boolean {
  if (typeof call.remoteMuted === 'boolean') return call.remoteMuted;
  return Boolean(peerParticipant(call)?.muted);
}

/**
 * Remote camera intent from `call.video` signaling (not frame presence).
 * Defaults to true until the peer reports otherwise — avoids treating
 * decoder stalls as "camera off".
 */
export function isRemoteVideoEnabled(call: ActiveCall): boolean {
  if (typeof call.remoteVideoEnabled === 'boolean') return call.remoteVideoEnabled;
  const fromParticipant = peerParticipant(call)?.videoEnabled;
  if (typeof fromParticipant === 'boolean') return fromParticipant;
  return true;
}

/** True when the stream has a live, enabled video track. */
export function hasLiveVideoTrack(stream: MediaStreamLike | null | undefined): boolean {
  if (!stream || typeof stream.getVideoTracks !== 'function') return false;
  return stream.getVideoTracks().some((t) => {
    const ended = (t as { readyState?: string }).readyState === 'ended';
    return !ended && t.enabled !== false;
  });
}
