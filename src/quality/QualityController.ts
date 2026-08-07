import type { QualityTier } from '@alaznah/protocol';
import type { CallQualitySnapshot } from '../types/index.js';

/** Minimum Opus bitrate — audio must never drop below this during a call. */
export const AUDIO_FLOOR_KBPS = 32;

export type QualityStatsSample = {
  rttMs: number | null;
  /** Combined inbound loss (legacy). */
  packetLoss: number | null;
  audioPacketLoss?: number | null;
  videoPacketLoss?: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  audioBitrateKbps?: number | null;
  videoBitrateKbps?: number | null;
  audioPacketsReceived?: number | null;
  candidateType: string | null;
  framesDropped?: number | null;
  availableOutgoingBitrateKbps?: number | null;
};

export type QualityDecision = {
  tier: QualityTier;
  videoEnabled: boolean;
  maxBitrateKbps: number;
  audioMaxBitrateKbps: number;
  scaleResolutionDownBy: number;
  maxFramerate: number;
  reason: string;
};

const TIER_ORDER: QualityTier[] = ['audio-only', 'low', 'medium', 'high'];

const TIER_CONFIG: Record<
  QualityTier,
  {
    maxBitrateKbps: number;
    audioMaxBitrateKbps: number;
    scale: number;
    maxFramerate: number;
    video: boolean;
    /** Minimum outbound bandwidth (audio + video) to sustain this tier. */
    minBandwidthKbps: number;
  }
> = {
  'audio-only': {
    maxBitrateKbps: 0,
    audioMaxBitrateKbps: AUDIO_FLOOR_KBPS,
    scale: 1,
    maxFramerate: 0,
    video: false,
    minBandwidthKbps: AUDIO_FLOOR_KBPS + 8,
  },
  low: {
    maxBitrateKbps: 500,
    audioMaxBitrateKbps: AUDIO_FLOOR_KBPS,
    scale: 1,
    maxFramerate: 20,
    video: true,
    minBandwidthKbps: AUDIO_FLOOR_KBPS + 200,
  },
  medium: {
    maxBitrateKbps: 1000,
    audioMaxBitrateKbps: 40,
    scale: 1,
    maxFramerate: 24,
    video: true,
    minBandwidthKbps: AUDIO_FLOOR_KBPS + 450,
  },
  high: {
    maxBitrateKbps: 1800,
    audioMaxBitrateKbps: 48,
    scale: 1,
    maxFramerate: 30,
    video: true,
    minBandwidthKbps: AUDIO_FLOOR_KBPS + 900,
  },
};

function tierFromNetworkStress(sample: QualityStatsSample): QualityTier {
  const rtt = sample.rttMs ?? 0;
  const jitter = sample.jitterMs ?? 0;
  const videoLoss = sample.videoPacketLoss ?? sample.packetLoss ?? 0;
  const drops = sample.framesDropped ?? 0;
  const avail = sample.availableOutgoingBitrateKbps;

  // Prefer keeping video on — only step down resolution/bitrate tiers.
  // Never return audio-only from stress alone (that freezes/blinks remote video).
  if (videoLoss > 0.25 || rtt > 800 || jitter > 120 || drops > 60) {
    return 'low';
  }

  if (videoLoss > 0.1 || rtt > 400 || jitter > 70) {
    return 'medium';
  }

  if (avail != null && avail > 0) {
    const videoBudget = avail - AUDIO_FLOOR_KBPS - 16;
    if (videoBudget < 250) return 'low';
    if (videoBudget < 550) return 'medium';
  }

  return 'high';
}

function tierIndex(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier);
}

function isExcellentNetwork(sample: QualityStatsSample): boolean {
  const loss = sample.videoPacketLoss ?? sample.packetLoss ?? 1;
  const rtt = sample.rttMs ?? 9999;
  const avail = sample.availableOutgoingBitrateKbps ?? 0;
  return loss < 0.02 && rtt < 80 && avail > 1200;
}

/**
 * Hysteresis-based quality controller (WhatsApp-style):
 * - Downgrade immediately when conditions worsen (video first, audio protected)
 * - Upgrade cautiously after sustained recovery
 */
export class QualityController {
  private currentTier: QualityTier;
  private healthyStreak = 0;
  private audioOnlyStressStreak = 0;
  private readonly upgradeStreakRequired: number;
  private readonly mediaWantsVideo: boolean;

  constructor(
    options: {
      initialTier?: QualityTier;
      mediaWantsVideo?: boolean;
      upgradeStreakRequired?: number;
    } = {},
  ) {
    this.mediaWantsVideo = options.mediaWantsVideo ?? true;
    this.currentTier =
      options.initialTier ?? (this.mediaWantsVideo ? 'low' : 'audio-only');
    this.upgradeStreakRequired = options.upgradeStreakRequired ?? 3;
  }

  getTier(): QualityTier {
    return this.currentTier;
  }

  decide(sample: QualityStatsSample): QualityDecision {
    let target = this.mediaWantsVideo
      ? tierFromNetworkStress(sample)
      : 'audio-only';

    // Video calls never drop to audio-only via adaptive — that freezes remote video.
    if (this.mediaWantsVideo && target === 'audio-only') {
      target = 'low';
    }

    const currentIdx = tierIndex(this.currentTier);
    const targetIdx = tierIndex(target);

    let reason = 'hold';

    if (targetIdx < currentIdx) {
      // Require 2 consecutive worse samples before downgrade (anti-thrash).
      this.healthyStreak = 0;
      this.audioOnlyStressStreak += 1;
      if (this.audioOnlyStressStreak >= 2) {
        this.currentTier = target;
        this.audioOnlyStressStreak = 0;
        reason = `downgrade:${target}`;
      } else {
        reason = `probe-downgrade:${this.audioOnlyStressStreak}/2`;
      }
    } else if (targetIdx > currentIdx) {
      this.audioOnlyStressStreak = 0;
      this.healthyStreak += 1;
      let streakNeeded = Math.max(4, this.upgradeStreakRequired);
      if (this.currentTier === 'low' && isExcellentNetwork(sample)) {
        streakNeeded = 3;
      }
      if (this.healthyStreak >= streakNeeded) {
        this.currentTier = TIER_ORDER[currentIdx + 1]!;
        this.healthyStreak = 0;
        reason = `upgrade:${this.currentTier}`;
      } else {
        reason = `probe-upgrade:${this.healthyStreak}/${streakNeeded}`;
      }
    } else {
      this.healthyStreak = 0;
      this.audioOnlyStressStreak = 0;
    }

    const cfg = TIER_CONFIG[this.currentTier];
    return {
      tier: this.currentTier,
      videoEnabled: cfg.video && this.mediaWantsVideo,
      maxBitrateKbps: cfg.maxBitrateKbps,
      audioMaxBitrateKbps: Math.max(AUDIO_FLOOR_KBPS, cfg.audioMaxBitrateKbps),
      scaleResolutionDownBy: cfg.scale,
      maxFramerate: cfg.maxFramerate,
      reason,
    };
  }

  toSnapshot(sample: QualityStatsSample, videoEnabled: boolean): CallQualitySnapshot {
    return {
      tier: this.currentTier,
      rttMs: sample.rttMs,
      packetLoss: sample.packetLoss,
      jitterMs: sample.jitterMs,
      bitrateKbps: sample.bitrateKbps,
      audioBitrateKbps: sample.audioBitrateKbps ?? null,
      videoBitrateKbps: sample.videoBitrateKbps ?? null,
      candidateType: sample.candidateType,
      videoEnabled,
    };
  }
}

export function getConstraintsForTier(tier: QualityTier): {
  video: false | { width: number; height: number; frameRate: number };
} {
  switch (tier) {
    case 'high':
      return { video: { width: 1280, height: 720, frameRate: 30 } };
    case 'medium':
      return { video: { width: 960, height: 540, frameRate: 24 } };
    case 'low':
      return { video: { width: 480, height: 270, frameRate: 15 } };
    default:
      return { video: false };
  }
}
