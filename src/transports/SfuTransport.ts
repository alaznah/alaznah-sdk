import type { CallTransport } from '../domain/session.js';

/**
 * Future SFU transport stub. Phase-1 shipping path uses DirectPeerTransport only.
 */
export function createSfuTransport(): CallTransport {
  throw new Error('SFU transport is not available in Phase 1 (1:1 P2P only)');
}
