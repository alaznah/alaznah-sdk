import type { SdkEntitlement, SdkFeature } from '../types/index.js';

export class EntitlementError extends Error {
  readonly code = 'ENTITLEMENT_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'EntitlementError';
  }
}

export function assertEntitlementActive(entitlement: SdkEntitlement): void {
  const now = Date.now();
  const grace = entitlement.graceUntil ?? entitlement.expiresAt;
  if (now > grace) {
    throw new EntitlementError(
      `SDK entitlement expired for project ${entitlement.projectId}`,
    );
  }
}

export function assertFeatureEnabled(
  entitlement: SdkEntitlement,
  feature: SdkFeature,
): void {
  assertEntitlementActive(entitlement);
  if (!entitlement.features.includes(feature)) {
    throw new EntitlementError(
      `Feature "${feature}" is not enabled on plan "${entitlement.plan}"`,
    );
  }
}
