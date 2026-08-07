import { Platform } from 'react-native';
import { isIosSimulator } from './CallKeepBridge.js';

type InCallManagerModule = {
  start: (options?: {
    media?: 'audio' | 'video';
    auto?: boolean;
    ringback?: string;
  }) => void;
  stop: (options?: { busysound?: string }) => void;
  startRingtone: (
    ringtone: string,
    vibrate_pattern?: number[],
    ios_category?: string,
    seconds?: number,
  ) => void;
  stopRingtone: () => void;
  startRingback: (ringback?: string) => void;
  stopRingback: () => void;
  setForceSpeakerphoneOn: (flag: boolean | null) => void;
  setSpeakerphoneOn: (enable: boolean) => void;
};

function loadInCallManager(): InCallManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-incall-manager');
    return (mod.default ?? mod) as InCallManagerModule;
  } catch {
    return null;
  }
}

/**
 * Owns AVAudioSession / Android audio routing for WebRTC.
 *
 * Policy:
 * - audio calls → earpiece (speaker off)
 * - video calls → speaker on
 * - iOS Simulator → always force speaker (VoiceProcessing crash workaround)
 * - wired/Bluetooth headset routes remain preferred by the OS when present
 */
export class AudioSessionController {
  private inCall = loadInCallManager();
  private active = false;
  private speakerForced = false;

  /**
   * Call BEFORE getUserMedia / setLocalDescription / setRemoteDescription.
   */
  prepareForWebRtc(mediaType: 'audio' | 'video'): void {
    if (!this.inCall) return;
    try {
      this.inCall.stopRingtone?.();
      this.inCall.stopRingback?.();
      this.inCall.start({
        media: mediaType === 'video' ? 'video' : 'audio',
        auto: false,
      });
      const preferSpeaker =
        mediaType === 'video' || (Platform.OS === 'ios' && isIosSimulator());
      this.active = true;
      // Apply speaker after start so InCallManager owns the session first.
      this.applySpeaker(preferSpeaker);
    } catch (err) {
      console.warn('[AudioSession] prepareForWebRtc failed', err);
    }
  }

  setSpeaker(enabled: boolean): void {
    // Allow speaker updates even if prepare raced — keep call audio audible.
    if (!this.inCall) return;
    if (!this.active) {
      try {
        this.inCall.start({ media: enabled ? 'video' : 'audio', auto: false });
        this.active = true;
      } catch {
        return;
      }
    }
    // Never disable speaker on iOS Simulator — VoiceProcessing aborts.
    if (!enabled && Platform.OS === 'ios' && isIosSimulator()) {
      this.applySpeaker(true);
      return;
    }
    this.applySpeaker(enabled);
  }

  private applySpeaker(enabled: boolean): void {
    if (!this.inCall) return;
    try {
      this.speakerForced = enabled;
      // InCallManager: true → force speaker, false → force earpiece/handset,
      // null → OS default (video media defaults to speaker — so never use null to "turn off").
      this.inCall.setForceSpeakerphoneOn(enabled);
      this.inCall.setSpeakerphoneOn?.(enabled);
    } catch {
      // ignore
    }
  }

  getSpeakerForced(): boolean {
    return this.speakerForced;
  }

  stop(): void {
    if (!this.inCall) return;
    try {
      this.inCall.stopRingtone?.();
      this.inCall.stopRingback?.();
      if (this.active) {
        this.inCall.stop();
      }
    } catch {
      // ignore
    }
    this.active = false;
    this.speakerForced = false;
  }
}
