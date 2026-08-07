import type { CallState } from '@alaznah/protocol';

const TRANSITIONS: Record<CallState, CallState[]> = {
  idle: ['connecting', 'ringing'],
  // Outbound stays in connecting until call.ringing; invite TTL / offline peer can miss earlier.
  connecting: ['ringing', 'accepted', 'connected', 'failed', 'ended', 'rejected', 'missed', 'busy'],
  ringing: ['accepted', 'connected', 'ended', 'rejected', 'missed', 'busy', 'failed'],
  accepted: ['connected', 'reconnecting', 'ended', 'failed'],
  connected: ['reconnecting', 'ended', 'failed'],
  reconnecting: ['connected', 'ended', 'failed'],
  ended: [],
  failed: [],
  rejected: [],
  missed: [],
  busy: [],
};

export function canTransition(from: CallState, to: CallState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionCallState(from: CallState, to: CallState): CallState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid call state transition: ${from} -> ${to}`);
  }
  return to;
}

export function isTerminalState(state: CallState): boolean {
  return ['ended', 'failed', 'rejected', 'missed', 'busy'].includes(state);
}
