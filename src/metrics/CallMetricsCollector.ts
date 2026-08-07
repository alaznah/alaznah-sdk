/**
 * Internal-only call metrics (not exported in public API).
 * Used by the benchmark suite to compare builds objectively.
 */
export type CallMetricsSnapshot = {
  callId: string;
  /** ms from invite/start to first connected state */
  joinTimeMs: number | null;
  /** ms from engine start to PC connected */
  iceTimeMs: number | null;
  /** ms from connected to first inbound audio packet (when available) */
  firstAudioMs: number | null;
  /** ms from connected to first remote video frame */
  firstVideoMs: number | null;
  reconnectCount: number;
  iceRestartCount: number;
  turnRelayUsed: boolean;
  lastRttMs: number | null;
  lastPacketLoss: number | null;
  lastAudioBitrateKbps: number | null;
  lastVideoBitrateKbps: number | null;
  lastTier: string | null;
};

export class CallMetricsCollector {
  private readonly byCall = new Map<string, Partial<CallMetricsSnapshot> & { startedAt?: number; engineAt?: number; connectedAt?: number }>();

  beginCall(callId: string): void {
    this.byCall.set(callId, { callId, startedAt: Date.now(), reconnectCount: 0, iceRestartCount: 0, turnRelayUsed: false });
  }

  markEngineStart(callId: string): void {
    const row = this.byCall.get(callId);
    if (!row) return;
    row.engineAt = Date.now();
  }

  markConnected(callId: string, candidateType: string | null): void {
    const row = this.byCall.get(callId);
    if (!row || row.connectedAt) return;
    row.connectedAt = Date.now();
    if (row.startedAt) row.joinTimeMs = row.connectedAt - row.startedAt;
    if (row.engineAt) row.iceTimeMs = row.connectedAt - row.engineAt;
    if (candidateType === 'relay') row.turnRelayUsed = true;
  }

  markReconnect(callId: string): void {
    const row = this.byCall.get(callId);
    if (!row) return;
    row.reconnectCount = (row.reconnectCount ?? 0) + 1;
  }

  markIceRestart(callId: string): void {
    const row = this.byCall.get(callId);
    if (!row) return;
    row.iceRestartCount = (row.iceRestartCount ?? 0) + 1;
  }

  updateMedia(callId: string, patch: {
    rttMs?: number | null;
    packetLoss?: number | null;
    audioBitrateKbps?: number | null;
    videoBitrateKbps?: number | null;
    tier?: string | null;
    hasAudio?: boolean;
    hasVideo?: boolean;
  }): void {
    const row = this.byCall.get(callId);
    if (!row || !row.connectedAt) return;
    const now = Date.now();
    if (patch.hasAudio && row.firstAudioMs == null) {
      row.firstAudioMs = now - row.connectedAt;
    }
    if (patch.hasVideo && row.firstVideoMs == null) {
      row.firstVideoMs = now - row.connectedAt;
    }
    if (patch.rttMs != null) row.lastRttMs = patch.rttMs;
    if (patch.packetLoss != null) row.lastPacketLoss = patch.packetLoss;
    if (patch.audioBitrateKbps != null) row.lastAudioBitrateKbps = patch.audioBitrateKbps;
    if (patch.videoBitrateKbps != null) row.lastVideoBitrateKbps = patch.videoBitrateKbps;
    if (patch.tier != null) row.lastTier = patch.tier;
  }

  finish(callId: string): CallMetricsSnapshot | null {
    const row = this.byCall.get(callId);
    if (!row) return null;
    this.byCall.delete(callId);
    return {
      callId,
      joinTimeMs: row.joinTimeMs ?? null,
      iceTimeMs: row.iceTimeMs ?? null,
      firstAudioMs: row.firstAudioMs ?? null,
      firstVideoMs: row.firstVideoMs ?? null,
      reconnectCount: row.reconnectCount ?? 0,
      iceRestartCount: row.iceRestartCount ?? 0,
      turnRelayUsed: row.turnRelayUsed ?? false,
      lastRttMs: row.lastRttMs ?? null,
      lastPacketLoss: row.lastPacketLoss ?? null,
      lastAudioBitrateKbps: row.lastAudioBitrateKbps ?? null,
      lastVideoBitrateKbps: row.lastVideoBitrateKbps ?? null,
      lastTier: row.lastTier ?? null,
    };
  }

  /** Test / benchmark hook */
  peek(callId: string): CallMetricsSnapshot | null {
    const row = this.byCall.get(callId);
    if (!row) return null;
    return {
      callId,
      joinTimeMs: row.joinTimeMs ?? null,
      iceTimeMs: row.iceTimeMs ?? null,
      firstAudioMs: row.firstAudioMs ?? null,
      firstVideoMs: row.firstVideoMs ?? null,
      reconnectCount: row.reconnectCount ?? 0,
      iceRestartCount: row.iceRestartCount ?? 0,
      turnRelayUsed: row.turnRelayUsed ?? false,
      lastRttMs: row.lastRttMs ?? null,
      lastPacketLoss: row.lastPacketLoss ?? null,
      lastAudioBitrateKbps: row.lastAudioBitrateKbps ?? null,
      lastVideoBitrateKbps: row.lastVideoBitrateKbps ?? null,
      lastTier: row.lastTier ?? null,
    };
  }
}
