import type { CallMetricsSnapshot } from '../metrics/CallMetricsCollector.js';
import baseline from './baseline.json';

export type BaselineTargets = typeof baseline.targets;

export function loadBenchmarkBaseline(): {
  targets: BaselineTargets;
  sample: CallMetricsSnapshot;
} {
  return {
    targets: baseline.targets,
    sample: baseline.sample as CallMetricsSnapshot,
  };
}

export type BaselineViolation = {
  metric: keyof BaselineTargets;
  actual: number | boolean | null;
  rule: string;
};

/**
 * Check a call metrics snapshot against Phase 1 baseline thresholds.
 * Used in CI before device matrix runs.
 */
export function checkAgainstBaseline(
  metrics: CallMetricsSnapshot,
  targets: BaselineTargets = baseline.targets,
): BaselineViolation[] {
  const violations: BaselineViolation[] = [];

  const num = (key: keyof CallMetricsSnapshot): number | null => {
    const v = metrics[key];
    return typeof v === 'number' ? v : null;
  };

  for (const [key, rule] of Object.entries(targets) as [keyof BaselineTargets, BaselineTargets[keyof BaselineTargets]][]) {
    if (key === 'turnRelayUsed') {
      const rateRule = rule as { maxRate: number };
      if (metrics.turnRelayUsed && rateRule.maxRate < 1) {
        violations.push({ metric: key, actual: true, rule: `relay used (target max rate ${rateRule.maxRate})` });
      }
      continue;
    }

    const value = num(key as keyof CallMetricsSnapshot);
    if (value == null) continue;

    if ('max' in rule && value > rule.max) {
      violations.push({ metric: key, actual: value, rule: `max ${rule.max}` });
    }
    if ('min' in rule && value < rule.min) {
      violations.push({ metric: key, actual: value, rule: `min ${rule.min}` });
    }
  }

  return violations;
}

export function passesBaseline(metrics: CallMetricsSnapshot): boolean {
  return checkAgainstBaseline(metrics).length === 0;
}
