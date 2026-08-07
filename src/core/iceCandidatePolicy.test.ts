import { describe, expect, it } from 'vitest';
import {
  iceCandidatePriority,
  parseIceCandidateType,
  shouldTrickleLocalCandidate,
  sortIceCandidatesByPriority,
} from './iceCandidatePolicy.js';

describe('iceCandidatePolicy', () => {
  const host = 'candidate:1 1 udp 2130706431 192.168.1.2 54321 typ host';
  const srflx = 'candidate:2 1 udp 1694498815 203.0.113.1 54321 typ srflx';
  const relay = 'candidate:3 1 udp 16777215 203.0.113.9 54321 typ relay';

  it('parses candidate types', () => {
    expect(parseIceCandidateType(host)).toBe('host');
    expect(parseIceCandidateType(srflx)).toBe('srflx');
    expect(parseIceCandidateType(relay)).toBe('relay');
  });

  it('prefers host over relay for trickle when relay not allowed', () => {
    expect(shouldTrickleLocalCandidate(host, { allowRelay: false })).toBe(true);
    expect(shouldTrickleLocalCandidate(relay, { allowRelay: false })).toBe(false);
    expect(shouldTrickleLocalCandidate(relay, { allowRelay: true })).toBe(true);
  });

  it('sorts by P2P priority', () => {
    const sorted = sortIceCandidatesByPriority([
      { candidate: relay },
      { candidate: host },
      { candidate: srflx },
    ]);
    expect(sorted.map((c) => parseIceCandidateType(c.candidate))).toEqual([
      'host',
      'srflx',
      'relay',
    ]);
    expect(iceCandidatePriority(host)).toBeGreaterThan(iceCandidatePriority(relay));
  });
});
