/**
 * Network matrix — video stays on; adaptive only steps bitrate tiers.
 */
import { describe, expect, it } from 'vitest';
import { QualityController } from './QualityController.js';

type MatrixRow = {
  label: string;
  sample: {
    rttMs: number;
    packetLoss: number;
    videoPacketLoss: number;
    audioPacketLoss: number;
    jitterMs: number;
    bitrateKbps: number;
    availableOutgoingBitrateKbps?: number;
    candidateType: string;
  };
  expectTier: 'low' | 'medium' | 'high';
  repeats?: number;
};

const rows: MatrixRow[] = [
  {
    label: '12% video loss',
    sample: {
      rttMs: 80,
      packetLoss: 0.12,
      videoPacketLoss: 0.12,
      audioPacketLoss: 0.01,
      jitterMs: 20,
      bitrateKbps: 400,
      candidateType: 'srflx',
    },
    expectTier: 'medium',
    repeats: 2,
  },
  {
    label: '30% video loss',
    sample: {
      rttMs: 120,
      packetLoss: 0.3,
      videoPacketLoss: 0.3,
      audioPacketLoss: 0.02,
      jitterMs: 40,
      bitrateKbps: 200,
      candidateType: 'relay',
    },
    expectTier: 'low',
    repeats: 2,
  },
  {
    label: 'RTT 100ms good',
    sample: {
      rttMs: 100,
      packetLoss: 0.01,
      videoPacketLoss: 0.01,
      audioPacketLoss: 0.005,
      jitterMs: 15,
      bitrateKbps: 900,
      availableOutgoingBitrateKbps: 2000,
      candidateType: 'host',
    },
    expectTier: 'high',
  },
  {
    label: 'RTT 450ms',
    sample: {
      rttMs: 450,
      packetLoss: 0.02,
      videoPacketLoss: 0.02,
      audioPacketLoss: 0.01,
      jitterMs: 35,
      bitrateKbps: 500,
      candidateType: 'srflx',
    },
    expectTier: 'medium',
    repeats: 2,
  },
  {
    label: 'RTT 900ms',
    sample: {
      rttMs: 900,
      packetLoss: 0.03,
      videoPacketLoss: 0.03,
      audioPacketLoss: 0.01,
      jitterMs: 50,
      bitrateKbps: 300,
      candidateType: 'relay',
    },
    expectTier: 'low',
    repeats: 2,
  },
];

describe('network matrix (stable video)', () => {
  for (const row of rows) {
    it(`${row.label} → ${row.expectTier}`, () => {
      const qc = new QualityController({ initialTier: 'high', mediaWantsVideo: true });
      const repeats = row.repeats ?? 1;
      let decision = qc.decide(row.sample);
      for (let i = 1; i < repeats; i += 1) {
        decision = qc.decide(row.sample);
      }
      expect(decision.tier).toBe(row.expectTier);
      expect(decision.videoEnabled).toBe(true);
      expect(decision.audioMaxBitrateKbps).toBeGreaterThanOrEqual(32);
    });
  }
});
