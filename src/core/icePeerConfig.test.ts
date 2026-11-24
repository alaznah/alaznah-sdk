import { describe, expect, it } from 'vitest';
import type { IceServerConfig } from '@alaznah/protocol';
import {
  iceCandidatePriority,
  shouldTrickleLocalCandidate,
} from './iceCandidatePolicy.js';
import {
  DEFAULT_STUN_SERVERS,
  hasTurnServers,
  iceServersForPeerConnection,
  stunOnlyIceServers,
} from './icePeerConfig.js';

const STUN: IceServerConfig = {
  urls: ['stun:stun.l.google.com:19302'],
};
const TURN: IceServerConfig = {
  urls: [
    'turn:turn.alaznah.com:3478?transport=udp',
    'turn:turn.alaznah.com:3478?transport=tcp',
  ],
  username: 'user',
  credential: 'cred',
};

const host = 'candidate:1 1 udp 2130706431 192.168.1.2 54321 typ host';
const srflx = 'candidate:2 1 udp 1694498815 203.0.113.1 54321 typ srflx';
const relay = 'candidate:3 1 udp 16777215 203.0.113.9 54321 typ relay';

describe('calling connect matrix (ICE / TURN)', () => {
  it('same-lan: first PC keeps TURN, ICE still prefers host over relay', () => {
    const pc = iceServersForPeerConnection([STUN, TURN]);
    expect(hasTurnServers(pc)).toBe(true);
    expect(iceCandidatePriority(host)).toBeGreaterThan(iceCandidatePriority(srflx));
    expect(iceCandidatePriority(srflx)).toBeGreaterThan(iceCandidatePriority(relay));
  });

  it('different-wifi / wifi-cellular: first PC is not STUN-only', () => {
    const pc = iceServersForPeerConnection([STUN, TURN]);
    const urls = pc.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).map(String);
    expect(urls.some((u) => u.startsWith('turn:'))).toBe(true);
    expect(stunOnlyIceServers(pc).every((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).every((u) => String(u).startsWith('stun:')),
    )).toBe(true);
  });

  it('wifi-cellular: relay candidates are trickled from the first gather', () => {
    expect(shouldTrickleLocalCandidate(host, { allowRelay: true })).toBe(true);
    expect(shouldTrickleLocalCandidate(srflx, { allowRelay: true })).toBe(true);
    expect(shouldTrickleLocalCandidate(relay, { allowRelay: true })).toBe(true);
  });

  it('falls back to public STUN when TURN credentials are missing', () => {
    const pc = iceServersForPeerConnection([]);
    expect(hasTurnServers(pc)).toBe(false);
    expect(pc).toEqual(DEFAULT_STUN_SERVERS);
  });
});
