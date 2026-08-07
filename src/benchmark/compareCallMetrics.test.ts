import { describe, expect, it } from 'vitest';
import { compareCallMetrics, hasRegressions } from './compareCallMetrics.js';
import type { CallMetricsSnapshot } from '../metrics/CallMetricsCollector.js';

const base = (patch: Partial<CallMetricsSnapshot>): CallMetricsSnapshot => ({
  callId: 'x',
  joinTimeMs: 1000,
  iceTimeMs: 800,
  firstAudioMs: 200,
  firstVideoMs: 400,
  reconnectCount: 0,
  iceRestartCount: 0,
  turnRelayUsed: false,
  lastRttMs: 50,
  lastPacketLoss: 0.02,
  lastAudioBitrateKbps: 32,
  lastVideoBitrateKbps: 400,
  lastTier: 'medium',
  ...patch,
});

describe('compareCallMetrics', () => {
  it('flags slower join time as regression', () => {
    const report = compareCallMetrics(base({}), base({ joinTimeMs: 1200 }));
    const join = report.find((r) => r.metric === 'joinTimeMs');
    expect(join?.regressed).toBe(true);
    expect(hasRegressions(report)).toBe(true);
  });

  it('flags higher audio bitrate as improvement not regression', () => {
    const report = compareCallMetrics(base({}), base({ lastAudioBitrateKbps: 40 }));
    const audio = report.find((r) => r.metric === 'lastAudioBitrateKbps');
    expect(audio?.regressed).toBe(false);
  });
});
