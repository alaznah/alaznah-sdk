import type { QualityStatsSample } from '../quality/QualityController.js';

type StatsLike = {
  type: string;
  kind?: string;
  currentRoundTripTime?: number;
  roundTripTime?: number;
  packetsLost?: number;
  packetsReceived?: number;
  packetsSent?: number;
  jitter?: number;
  bytesSent?: number;
  bytesReceived?: number;
  framesDropped?: number;
  availableOutgoingBitrate?: number;
  candidateType?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  state?: string;
  id?: string;
  nominated?: boolean;
};

export type StatsCollectorState = {
  lastTs?: number;
  lastAudioBytesReceived?: number;
  lastVideoBytesReceived?: number;
  lastAudioBytesSent?: number;
  lastVideoBytesSent?: number;
  lastAudioPacketsLost?: number;
  lastAudioPacketsReceived?: number;
  lastVideoPacketsLost?: number;
  lastVideoPacketsReceived?: number;
};

function toList(
  report: Map<string, StatsLike> | StatsLike[] | RTCStatsReport,
): StatsLike[] {
  const stats: StatsLike[] = [];
  if (report instanceof Map) {
    for (const value of report.values()) stats.push(value as StatsLike);
  } else if (Array.isArray(report)) {
    stats.push(...report);
  } else if (report && typeof (report as RTCStatsReport).forEach === 'function') {
    (report as RTCStatsReport).forEach((value) =>
      stats.push(value as unknown as StatsLike),
    );
  }
  return stats;
}

function intervalBitrateKbps(
  bytesNow: number,
  bytesPrev: number | undefined,
  elapsedMs: number,
): number | null {
  if (bytesPrev == null || elapsedMs <= 0) return null;
  const delta = Math.max(0, bytesNow - bytesPrev);
  return Math.round((delta * 8) / elapsedMs);
}

export async function collectQualityStats(
  getStats: () => Promise<Map<string, StatsLike> | StatsLike[] | RTCStatsReport>,
  state: StatsCollectorState = {},
): Promise<QualityStatsSample> {
  const stats = toList(await getStats());
  const now = Date.now();
  const elapsedMs = state.lastTs != null ? now - state.lastTs : 0;

  let rttMs: number | null = null;
  let jitterMs: number | null = null;
  let candidateType: string | null = null;
  let framesDropped: number | null = null;
  let availableOutgoingBitrateKbps: number | null = null;

  let audioBytesReceived = 0;
  let videoBytesReceived = 0;
  let audioBytesSent = 0;
  let videoBytesSent = 0;
  let audioPacketsLost = 0;
  let audioPacketsReceived = 0;
  let videoPacketsLost = 0;
  let videoPacketsReceived = 0;

  const candidates = new Map<string, StatsLike>();
  for (const s of stats) {
    if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
      if (s.id) candidates.set(s.id, s);
    }
  }

  for (const s of stats) {
    if (
      s.type === 'candidate-pair' &&
      (s.state === 'succeeded' || s.state === 'in-use' || s.nominated)
    ) {
      if (typeof s.currentRoundTripTime === 'number') {
        rttMs = Math.round(s.currentRoundTripTime * 1000);
      }
      const local = s.localCandidateId ? candidates.get(s.localCandidateId) : undefined;
      if (local?.candidateType) candidateType = local.candidateType;
    }

    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      audioBytesReceived += s.bytesReceived ?? 0;
      audioPacketsLost += s.packetsLost ?? 0;
      audioPacketsReceived += s.packetsReceived ?? 0;
      if (typeof s.jitter === 'number') jitterMs = Math.round(s.jitter * 1000);
    }

    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      videoBytesReceived += s.bytesReceived ?? 0;
      videoPacketsLost += s.packetsLost ?? 0;
      videoPacketsReceived += s.packetsReceived ?? 0;
      if (typeof s.framesDropped === 'number') framesDropped = s.framesDropped;
      if (typeof s.jitter === 'number' && jitterMs == null) {
        jitterMs = Math.round(s.jitter * 1000);
      }
    }

    if (s.type === 'outbound-rtp' && s.kind === 'audio') {
      audioBytesSent += s.bytesSent ?? 0;
    }
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      videoBytesSent += s.bytesSent ?? 0;
    }

    if (s.type === 'transport' && typeof s.availableOutgoingBitrate === 'number') {
      availableOutgoingBitrateKbps = Math.round(s.availableOutgoingBitrate / 1000);
    }
  }

  const audioBitrateKbps = intervalBitrateKbps(
    audioBytesReceived + audioBytesSent,
    (state.lastAudioBytesReceived ?? 0) + (state.lastAudioBytesSent ?? 0),
    elapsedMs,
  );
  const videoBitrateKbps = intervalBitrateKbps(
    videoBytesReceived + videoBytesSent,
    (state.lastVideoBytesReceived ?? 0) + (state.lastVideoBytesSent ?? 0),
    elapsedMs,
  );

  const audioLostDelta = Math.max(
    0,
    audioPacketsLost - (state.lastAudioPacketsLost ?? 0),
  );
  const audioRecvDelta = Math.max(
    0,
    audioPacketsReceived - (state.lastAudioPacketsReceived ?? 0),
  );
  const videoLostDelta = Math.max(
    0,
    videoPacketsLost - (state.lastVideoPacketsLost ?? 0),
  );
  const videoRecvDelta = Math.max(
    0,
    videoPacketsReceived - (state.lastVideoPacketsReceived ?? 0),
  );
  const audioTotal = audioLostDelta + audioRecvDelta;
  const videoTotal = videoLostDelta + videoRecvDelta;
  const audioPacketLoss = audioTotal > 0 ? audioLostDelta / audioTotal : null;
  const videoPacketLoss = videoTotal > 0 ? videoLostDelta / videoTotal : null;
  const lost = audioLostDelta + videoLostDelta;
  const received = audioRecvDelta + videoRecvDelta;
  const total = lost + received;
  const packetLoss = total > 0 ? lost / total : null;

  state.lastTs = now;
  state.lastAudioBytesReceived = audioBytesReceived;
  state.lastVideoBytesReceived = videoBytesReceived;
  state.lastAudioBytesSent = audioBytesSent;
  state.lastVideoBytesSent = videoBytesSent;
  state.lastAudioPacketsLost = audioPacketsLost;
  state.lastAudioPacketsReceived = audioPacketsReceived;
  state.lastVideoPacketsLost = videoPacketsLost;
  state.lastVideoPacketsReceived = videoPacketsReceived;

  const bitrateKbps =
    audioBitrateKbps != null || videoBitrateKbps != null
      ? (audioBitrateKbps ?? 0) + (videoBitrateKbps ?? 0)
      : null;

  return {
    rttMs,
    packetLoss,
    audioPacketLoss,
    videoPacketLoss,
    jitterMs,
    bitrateKbps,
    audioBitrateKbps,
    videoBitrateKbps,
    audioPacketsReceived,
    candidateType,
    framesDropped,
    availableOutgoingBitrateKbps,
  };
}
