import { describe, expect, it } from 'vitest';
import { CallMetricsCollector } from './CallMetricsCollector.js';

describe('CallMetricsCollector', () => {
  it('tracks join, ICE, and media milestones', () => {
    const m = new CallMetricsCollector();
    m.beginCall('c1');
    m.markEngineStart('c1');
    const t0 = Date.now();
    m.markConnected('c1', 'host');
    m.updateMedia('c1', {
      hasAudio: true,
      audioBitrateKbps: 32,
      rttMs: 45,
      packetLoss: 0.01,
      tier: 'low',
    });
    const snap = m.finish('c1');
    expect(snap?.callId).toBe('c1');
    expect(snap?.joinTimeMs).not.toBeNull();
    expect(snap?.iceTimeMs).not.toBeNull();
    expect(snap?.firstAudioMs).not.toBeNull();
    expect(snap?.lastRttMs).toBe(45);
    expect(snap?.turnRelayUsed).toBe(false);
    expect(t0).toBeLessThanOrEqual(Date.now());
  });

  it('counts reconnects and ICE restarts', () => {
    const m = new CallMetricsCollector();
    m.beginCall('c2');
    m.markReconnect('c2');
    m.markIceRestart('c2');
    m.markIceRestart('c2');
    const snap = m.peek('c2');
    expect(snap?.reconnectCount).toBe(1);
    expect(snap?.iceRestartCount).toBe(2);
  });
});
