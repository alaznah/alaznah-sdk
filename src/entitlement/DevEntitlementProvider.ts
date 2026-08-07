import type { EntitlementProvider, SdkEntitlement } from '../types/index.js';

/** Local development trial. Not a security boundary — mobile binaries are mutable. */
export function createDevEntitlementProvider(
  projectId = 'dev-project',
): EntitlementProvider {
  return {
    getEntitlement(): SdkEntitlement {
      const now = Date.now();
      return {
        projectId,
        plan: 'trial',
        features: ['audio', 'video'],
        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
        environment: 'development',
        maxConcurrentCalls: 2,
        graceUntil: now + 32 * 24 * 60 * 60 * 1000,
      };
    },
  };
}
