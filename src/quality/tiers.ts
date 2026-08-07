import type { QualityTier } from '@alaznah/protocol';

/** Documented bitrate ceilings used by the adaptive controller. */
export const QUALITY_TIER_BITRATES_KBPS: Record<QualityTier, number> = {
  'audio-only': 0,
  low: 250,
  medium: 700,
  high: 1500,
};
