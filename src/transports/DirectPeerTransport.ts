import type { CallTransport } from '../domain/session.js';
import type { PeerConnectionEngine } from '../core/PeerConnectionEngine.js';

/**
 * Current 1:1 WebRTC transport. Group calling will add `SfuTransport` beside
 * this without changing ActiveCall consumers.
 */
export function createDirectPeerTransport(options: {
  engine: PeerConnectionEngine;
  onClose?: (reason?: string) => Promise<void>;
}): CallTransport {
  return {
    kind: 'direct',
    async start() {
      // Media acquisition is owned by the calling client today.
    },
    async accept() {
      // Answer/SDP negotiation is owned by the calling client today.
    },
    async close(reason) {
      await options.engine.close();
      await options.onClose?.(reason);
    },
    setMuted(muted) {
      options.engine.setMuted(muted);
    },
    setVideoEnabled(enabled) {
      void options.engine.setVideoEnabled(enabled, true);
    },
  };
}
