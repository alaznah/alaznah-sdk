import { describe, expect, it } from 'vitest';
import { decideCallRecovery } from './resyncActiveCall.js';

describe('decideCallRecovery', () => {
  it('ignores calls before first media connect', () => {
    expect(
      decideCallRecovery({
        callId: 'c1',
        state: 'reconnecting',
        mediaConnectedOnce: false,
      }),
    ).toBe('none');
  });

  it('recovers immediately when PC failed', () => {
    expect(
      decideCallRecovery({
        callId: 'c1',
        state: 'connected',
        mediaConnectedOnce: true,
        pcState: 'failed',
      }),
    ).toBe('recover-now');
  });

  it('schedules ICE when disconnected but not failed', () => {
    expect(
      decideCallRecovery({
        callId: 'c1',
        state: 'connected',
        mediaConnectedOnce: true,
        pcState: 'disconnected',
        iceState: 'disconnected',
      }),
    ).toBe('schedule-ice');
  });
});
