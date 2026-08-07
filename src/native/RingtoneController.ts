import { Platform, Vibration } from 'react-native';

type InCallManagerModule = {
  startRingtone: (ringtone: string, vibrate_pattern?: number[], ios_category?: string, seconds?: number) => void;
  stopRingtone: () => void;
  startRingback: (ringback?: string) => void;
  stopRingback: () => void;
  stop: () => void;
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

export type RingtoneOptions = {
  /**
   * When true, play ringtone/ringback audio.
   * Must be stopped before WebRTC VoiceProcessing starts (iOS Simulator aborts
   * if UISound/ringtone AudioUnit races setLocalDescription).
   */
  allowAudio?: boolean;
};

/**
 * Incoming/outgoing alerts while ringing (before Accept / before WebRTC media).
 * iOS: bundled `incallmanager_ringtone` + Playback category so ring continues
 * in background (UIBackgroundModes=audio). No Vibration on iOS (Simulator maps
 * it to UISound and can crash WebRTC later).
 */
export class RingtoneController {
  private inCall = loadInCallManager();
  private vibrating = false;
  private mode: 'idle' | 'incoming' | 'outgoing' = 'idle';

  startIncoming(options: RingtoneOptions = {}): void {
    this.stop();
    this.mode = 'incoming';
    this.startVibrateLoop(true);
    if (!this.shouldPlayAudio(options)) return;
    try {
      // iOS Simulator has no /Library/Ringtones — use app-bundled sound.
      const uri = Platform.OS === 'ios' ? '_BUNDLE_' : '_DEFAULT_';
      // `playback` keeps ringing after Home (requires UIBackgroundModes audio).
      this.inCall!.startRingtone(uri, [0, 1000, 1000], 'playback', 60);
    } catch (err) {
      console.warn('[Ringtone] startIncoming audio failed; vibrate continues', err);
    }
  }

  startOutgoingRingback(options: RingtoneOptions = {}): void {
    this.stop();
    this.mode = 'outgoing';
    this.startVibrateLoop(false);
    if (!this.shouldPlayAudio(options)) return;
    try {
      this.inCall!.startRingback('_DTMF_');
    } catch (err) {
      console.warn('[Ringtone] startOutgoingRingback audio failed; vibrate continues', err);
    }
  }

  /** Call before getUserMedia / setLocalDescription / setRemoteDescription. */
  stop(): void {
    try {
      this.inCall?.stopRingtone?.();
      this.inCall?.stopRingback?.();
      // Do NOT call inCall.stop() here — AudioSessionController owns the
      // play-and-record session once WebRTC starts.
    } catch {
      // ignore
    }
    this.stopVibrate();
    this.mode = 'idle';
  }

  get currentMode(): 'idle' | 'incoming' | 'outgoing' {
    return this.mode;
  }

  private shouldPlayAudio(options: RingtoneOptions): boolean {
    if (options.allowAudio === false) return false;
    // Default: play for incoming when allowAudio omitted/true.
    if (options.allowAudio !== true && options.allowAudio !== undefined) return false;
    if (options.allowAudio !== true) return false;
    return this.inCall != null;
  }

  private startVibrateLoop(strong = true): void {
    // iOS Vibration → UISound on Simulator → can race VoiceProcessing later.
    if (Platform.OS === 'ios') return;
    this.stopVibrate();
    this.vibrating = true;
    Vibration.vibrate(strong ? [0, 900, 600, 900] : [0, 400, 800, 400], true);
  }

  private stopVibrate(): void {
    this.vibrating = false;
    Vibration.cancel();
  }
}
