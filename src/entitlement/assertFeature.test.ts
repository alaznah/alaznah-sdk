import { describe, expect, it } from 'vitest';
import {
  assertEntitlementActive,
  assertFeatureEnabled,
  EntitlementError,
} from './assertFeature.js';
import type { SdkEntitlement } from '../types/index.js';

const base = (): SdkEntitlement => ({
  projectId: 'proj',
  plan: 'trial',
  features: ['audio', 'video'],
  expiresAt: Date.now() + 60_000,
});

describe('entitlement gates', () => {
  it('allows active features', () => {
    expect(() => assertFeatureEnabled(base(), 'audio')).not.toThrow();
  });

  it('rejects missing features', () => {
    expect(() => assertFeatureEnabled(base(), 'group')).toThrow(EntitlementError);
  });

  it('rejects expired entitlements past grace', () => {
    const expired: SdkEntitlement = {
      ...base(),
      expiresAt: Date.now() - 10_000,
      graceUntil: Date.now() - 5_000,
    };
    expect(() => assertEntitlementActive(expired)).toThrow(EntitlementError);
  });
});
