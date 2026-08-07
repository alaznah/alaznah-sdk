import { describe, expect, it } from 'vitest';
import { AUDIO_FLOOR_KBPS, QualityController } from './QualityController.js';

describe('QualityController', () => {
  it('downgrades after sustained high packet loss but keeps video on', () => {
    const qc = new QualityController({ initialTier: 'high', mediaWantsVideo: true });
    const bad = {
      rttMs: 100,
      packetLoss: 0.3,
      videoPacketLoss: 0.3,
      jitterMs: 30,
      bitrateKbps: 200,
      candidateType: 'relay',
    };
    expect(qc.decide(bad).tier).toBe('high'); // probe
    const decision = qc.decide(bad);
    expect(decision.tier).toBe('low');
    expect(decision.videoEnabled).toBe(true);
  });

  it('drops to medium on moderate video loss', () => {
    const qc = new QualityController({ initialTier: 'high', mediaWantsVideo: true });
    const sample = {
      rttMs: 80,
      packetLoss: 0.12,
      videoPacketLoss: 0.12,
      audioPacketLoss: 0.01,
      jitterMs: 20,
      bitrateKbps: 400,
      candidateType: 'srflx',
    };
    qc.decide(sample);
    const decision = qc.decide(sample);
    expect(decision.tier).toBe('medium');
    expect(decision.audioMaxBitrateKbps).toBeGreaterThanOrEqual(AUDIO_FLOOR_KBPS);
    expect(decision.videoEnabled).toBe(true);
  });

  it('never goes audio-only on video calls even with audio loss', () => {
    const qc = new QualityController({ initialTier: 'high', mediaWantsVideo: true });
    const bad = {
      rttMs: 60,
      packetLoss: 0.2,
      audioPacketLoss: 0.25,
      videoPacketLoss: 0.02,
      jitterMs: 20,
      bitrateKbps: 400,
      candidateType: 'host',
    };
    for (let i = 0; i < 10; i += 1) {
      qc.decide(bad);
    }
    const decision = qc.decide(bad);
    expect(decision.tier).not.toBe('audio-only');
    expect(decision.videoEnabled).toBe(true);
  });

  it('upgrades after recovery from low', () => {
    const qc = new QualityController({
      initialTier: 'low',
      mediaWantsVideo: true,
      upgradeStreakRequired: 3,
    });
    const good = {
      rttMs: 40,
      packetLoss: 0.01,
      videoPacketLoss: 0.01,
      audioPacketLoss: 0.005,
      jitterMs: 10,
      bitrateKbps: 900,
      candidateType: 'srflx',
      availableOutgoingBitrateKbps: 2000,
    };
    expect(qc.decide(good).tier).toBe('low');
    expect(qc.decide(good).tier).toBe('low');
    expect(qc.decide(good).tier).toBe('medium');
  });

  it('requires several samples to upgrade when network is merely ok', () => {
    const qc = new QualityController({
      initialTier: 'low',
      mediaWantsVideo: true,
      upgradeStreakRequired: 4,
    });
    const ok = {
      rttMs: 120,
      packetLoss: 0.03,
      videoPacketLoss: 0.03,
      jitterMs: 25,
      bitrateKbps: 600,
      candidateType: 'srflx',
      availableOutgoingBitrateKbps: 900,
    };
    expect(qc.decide(ok).tier).toBe('low');
    expect(qc.decide(ok).tier).toBe('low');
    expect(qc.decide(ok).tier).toBe('low');
    expect(qc.decide(ok).tier).toBe('medium');
  });

  it('stays audio-only for audio calls', () => {
    const qc = new QualityController({ mediaWantsVideo: false });
    const decision = qc.decide({
      rttMs: 20,
      packetLoss: 0,
      jitterMs: 5,
      bitrateKbps: 40,
      candidateType: 'host',
      availableOutgoingBitrateKbps: 5000,
    });
    expect(decision.tier).toBe('audio-only');
  });

  it('caps at low tier on low available bandwidth instead of killing video', () => {
    const qc = new QualityController({ initialTier: 'high', mediaWantsVideo: true });
    const sample = {
      rttMs: 50,
      packetLoss: 0,
      jitterMs: 10,
      bitrateKbps: 120,
      candidateType: 'host',
      availableOutgoingBitrateKbps: 90,
    };
    qc.decide(sample);
    const decision = qc.decide(sample);
    expect(decision.tier).toBe('low');
    expect(decision.videoEnabled).toBe(true);
  });
});
