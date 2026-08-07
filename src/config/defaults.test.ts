import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOSTED_SIGNALING_URL,
  resolveSignalingUrl,
} from '../config/defaults.js';

describe('resolveSignalingUrl', () => {
  it('uses explicit signalingUrl when provided', () => {
    expect(resolveSignalingUrl('wss://calls.acme.internal')).toBe(
      'wss://calls.acme.internal',
    );
    expect(resolveSignalingUrl('  ws://10.0.2.2:8080  ')).toBe(
      'ws://10.0.2.2:8080',
    );
  });

  it('falls back to hosted default when omitted or blank', () => {
    expect(resolveSignalingUrl()).toBe(DEFAULT_HOSTED_SIGNALING_URL);
    expect(resolveSignalingUrl('')).toBe(DEFAULT_HOSTED_SIGNALING_URL);
    expect(resolveSignalingUrl('   ')).toBe(DEFAULT_HOSTED_SIGNALING_URL);
  });

  it('placeholder default is a wss URL', () => {
    expect(DEFAULT_HOSTED_SIGNALING_URL.startsWith('wss://')).toBe(true);
  });
});
