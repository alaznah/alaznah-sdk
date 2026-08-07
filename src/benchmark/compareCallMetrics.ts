/**
 * Internal benchmark suite — compare build metrics objectively.
 * Not part of the public SDK API.
 */
import type { CallMetricsSnapshot } from '../metrics/CallMetricsCollector.js';

export type BenchmarkMetricKey =
  | 'joinTimeMs'
  | 'iceTimeMs'
  | 'firstAudioMs'
  | 'firstVideoMs'
  | 'reconnectCount'
  | 'iceRestartCount'
  | 'lastPacketLoss'
  | 'lastRttMs'
  | 'lastAudioBitrateKbps'
  | 'lastVideoBitrateKbps'
  | 'turnRelayUsed';

/** Lower is better for these metrics. */
const LOWER_IS_BETTER: BenchmarkMetricKey[] = [
  'joinTimeMs',
  'iceTimeMs',
  'firstAudioMs',
  'firstVideoMs',
  'reconnectCount',
  'iceRestartCount',
  'lastPacketLoss',
  'lastRttMs',
  'turnRelayUsed',
];

export type BenchmarkRegression = {
  metric: BenchmarkMetricKey;
  baseline: number | boolean | null;
  current: number | boolean | null;
  /** Positive = regression (worse), negative = improvement. */
  delta: number | null;
  regressed: boolean;
};

export function compareCallMetrics(
  baseline: CallMetricsSnapshot,
  current: CallMetricsSnapshot,
  tolerancePct = 5,
): BenchmarkRegression[] {
  const keys: BenchmarkMetricKey[] = [
    'joinTimeMs',
    'iceTimeMs',
    'firstAudioMs',
    'firstVideoMs',
    'reconnectCount',
    'iceRestartCount',
    'lastPacketLoss',
    'lastRttMs',
    'lastAudioBitrateKbps',
    'lastVideoBitrateKbps',
    'turnRelayUsed',
  ];

  return keys.map((metric) => {
    const b = baseline[metric as keyof CallMetricsSnapshot] as number | boolean | null;
    const c = current[metric as keyof CallMetricsSnapshot] as number | boolean | null;

    if (typeof b === 'boolean' || typeof c === 'boolean') {
      const regressed = b === false && c === true;
      return { metric, baseline: b, current: c, delta: null, regressed };
    }

    if (b == null || c == null) {
      return { metric, baseline: b, current: c, delta: null, regressed: false };
    }

    const delta = c - b;
    const lowerBetter = LOWER_IS_BETTER.includes(metric);
    const threshold = Math.abs(b) * (tolerancePct / 100);
    const regressed = lowerBetter ? delta > threshold : delta < -threshold;

    return { metric, baseline: b, current: c, delta, regressed };
  });
}

export function hasRegressions(report: BenchmarkRegression[]): boolean {
  return report.some((r) => r.regressed);
}
