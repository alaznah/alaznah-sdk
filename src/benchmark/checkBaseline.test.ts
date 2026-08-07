import { describe, expect, it } from 'vitest';
import { loadBenchmarkBaseline, checkAgainstBaseline, passesBaseline } from './checkBaseline.js';
import type { CallMetricsSnapshot } from '../metrics/CallMetricsCollector.js';

describe('checkBaseline', () => {
  it('loads baseline.json', () => {
    const { targets, sample } = loadBenchmarkBaseline();
    expect(targets.joinTimeMs.max).toBeGreaterThan(0);
    expect(sample.callId).toBe('baseline-sample');
  });

  it('passes the embedded sample snapshot', () => {
    const { sample } = loadBenchmarkBaseline();
    expect(passesBaseline(sample)).toBe(true);
  });

  it('flags regressions above max thresholds', () => {
    const bad: CallMetricsSnapshot = {
      ...loadBenchmarkBaseline().sample,
      joinTimeMs: 20_000,
      lastAudioBitrateKbps: 16,
    };
    const violations = checkAgainstBaseline(bad);
    expect(violations.some((v) => v.metric === 'joinTimeMs')).toBe(true);
    expect(violations.some((v) => v.metric === 'lastAudioBitrateKbps')).toBe(true);
  });
});
