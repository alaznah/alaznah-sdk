import { PermissionsAndroid, Platform } from 'react-native';
import type { ActiveCall } from '../types/index.js';

export type CallKeepBridgeOptions = {
  appName: string;
  imageName?: string;
  supportsVideo?: boolean;
  /** CallKit crashes on iOS Simulator — never set true there. */
  allowIosSimulator?: boolean;
};

export type CallKeepHandlers = {
  onAnswer: (callUUID: string) => void;
  onEnd: (callUUID: string) => void;
  onMute: (muted: boolean, callUUID: string) => void;
};

type CallKeepModule = {
  setup: (options: Record<string, unknown>) => Promise<boolean> | boolean | void;
  displayIncomingCall: (
    uuid: string,
    handle: string,
    localizedCallerName?: string,
    handleType?: string,
    hasVideo?: boolean,
  ) => void;
  startCall: (
    uuid: string,
    handle: string,
    contactIdentifier?: string,
    handleType?: string,
    hasVideo?: boolean,
  ) => void;
  endCall: (uuid: string) => void;
  setMutedCall: (uuid: string, muted: boolean) => void;
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => void;
};

/** RFC4122 UUID v4 — required by CallKit / CallKeep. */
export function generateCallUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Best-effort iOS Simulator detection without react-native-device-info.
 * Prefer disabling CallKeep in app config for simulator builds.
 */
export function isIosSimulator(): boolean {
  if (Platform.OS !== 'ios') return false;
  try {
    // Xcode / simctl inject these into some RN debug environments.
    if (
      process.env.SIMULATOR_DEVICE_NAME ||
      process.env.SIMULATOR_UDID ||
      process.env.SIMULATOR_HOST_HOME
    ) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    // Dev bundles on a simulator load from the host loopback; physical devices
    // must use a LAN IP (or file:// in release). Reliable in development.
    const scriptURL: string | undefined =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('react-native').NativeModules?.SourceCode?.scriptURL;
    if (scriptURL && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(scriptURL)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Thin optional wrapper around react-native-callkeep.
 * Never invokes CallKit on iOS Simulator — that SIGSEGVs the process.
 */
export class CallKeepBridge {
  private module: CallKeepModule | null = null;
  private enabled = false;
  private readonly callIdToUuid = new Map<string, string>();
  private readonly uuidToCallId = new Map<string, string>();

  get isEnabled(): boolean {
    return this.enabled;
  }

  async setup(options: CallKeepBridgeOptions, handlers: CallKeepHandlers): Promise<void> {
    if (Platform.OS === 'ios' && isIosSimulator() && !options.allowIosSimulator) {
      console.warn('[CallKeep] skipped on iOS Simulator (CallKit unsupported)');
      this.enabled = false;
      return;
    }

    // Telecom's ConnectionService calls getPhoneAccount(), which throws a fatal
    // SecurityException without READ_PHONE_NUMBERS on Android 12+ real devices.
    if (Platform.OS === 'android') {
      try {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS,
          PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
        ]);
        const granted =
          results[PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS] ===
          PermissionsAndroid.RESULTS.GRANTED;
        if (!granted) {
          console.warn(
            '[CallKeep] READ_PHONE_NUMBERS denied; skipping native call UI to avoid Telecom crash',
          );
          this.enabled = false;
          return;
        }
      } catch (err) {
        console.warn('[CallKeep] permission request failed; skipping native call UI', err);
        this.enabled = false;
        return;
      }
    }

    try {
      // Dynamic require so the SDK stays usable without CallKeep installed.
      // Accessing NativeModules.RNCallKeep can throw on RN New Architecture when
      // the native module has duplicate @ReactMethod overloads.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('react-native-callkeep');
      this.module = (mod.default ?? mod) as CallKeepModule;
      if (!this.module || typeof this.module.setup !== 'function') {
        throw new Error('react-native-callkeep module unavailable');
      }
    } catch (err) {
      this.module = null;
      this.enabled = false;
      console.warn('[CallKeep] unavailable; continuing without native call UI', err);
      return;
    }

    try {
      await this.module.setup({
        ios: {
          appName: options.appName,
          imageName: options.imageName,
          supportsVideo: options.supportsVideo ?? true,
        },
        android: {
          alertTitle: 'Permissions required',
          alertDescription: 'This app needs phone account permission to display incoming calls',
          cancelButton: 'Cancel',
          okButton: 'OK',
          selfManaged: true,
          foregroundService: {
            channelId: 'rnc.calling',
            channelName: 'Incoming Calls',
            notificationTitle: options.appName,
            notificationIcon: 'ic_launcher',
          },
        },
      });

      this.module.addEventListener('answerCall', (data) => {
        const uuid = String((data as { callUUID?: string }).callUUID ?? '');
        handlers.onAnswer(this.uuidToCallId.get(uuid) ?? uuid);
      });
      this.module.addEventListener('endCall', (data) => {
        const uuid = String((data as { callUUID?: string }).callUUID ?? '');
        handlers.onEnd(this.uuidToCallId.get(uuid) ?? uuid);
      });
      this.module.addEventListener('didPerformSetMutedCallAction', (data) => {
        const payload = data as { muted?: boolean; callUUID?: string };
        const uuid = String(payload.callUUID ?? '');
        handlers.onMute(Boolean(payload.muted), this.uuidToCallId.get(uuid) ?? uuid);
      });
      this.module.addEventListener('didReceiveStartCallAction', () => undefined);
      this.module.addEventListener('didActivateAudioSession', () => undefined);

      this.enabled = true;
    } catch (err) {
      this.enabled = false;
      this.module = null;
      console.warn('[CallKeep] setup failed; continuing without native call UI', err);
    }
  }

  /** Remember a callId ↔ CallKit UUID mapping without displaying a second UI. */
  mapCallId(callId: string, uuid: string = callId): void {
    this.map(callId, uuid);
  }

  displayIncoming(call: ActiveCall): void {
    if (!this.enabled || !this.module) return;
    const uuid = this.ensureUuid(call.callId);
    this.map(call.callId, uuid);
    try {
      this.module.displayIncomingCall(
        uuid,
        call.peerId,
        call.peerId,
        'generic',
        call.mediaType === 'video',
      );
    } catch (err) {
      this.disable(err, 'displayIncomingCall');
    }
  }

  startOutgoing(call: ActiveCall): void {
    if (!this.enabled || !this.module) return;
    const uuid = this.ensureUuid(call.callId);
    this.map(call.callId, uuid);
    try {
      this.module.startCall(uuid, call.peerId, call.peerId, 'generic', call.mediaType === 'video');
    } catch (err) {
      this.disable(err, 'startCall');
    }
  }

  end(callId: string): void {
    if (!this.enabled || !this.module) return;
    const uuid = this.callIdToUuid.get(callId) ?? this.ensureUuid(callId);
    try {
      this.module.endCall(uuid);
    } catch (err) {
      this.disable(err, 'endCall');
    }
    this.unmap(callId);
  }

  setMuted(callId: string, muted: boolean): void {
    if (!this.enabled || !this.module) return;
    const uuid = this.callIdToUuid.get(callId) ?? this.ensureUuid(callId);
    try {
      this.module.setMutedCall(uuid, muted);
    } catch (err) {
      this.disable(err, 'setMutedCall');
    }
  }

  private ensureUuid(callId: string): string {
    const existing = this.callIdToUuid.get(callId);
    if (existing) return existing;
    if (isUuid(callId)) return callId;
    return generateCallUuid();
  }

  private map(callId: string, uuid: string): void {
    this.callIdToUuid.set(callId, uuid);
    this.uuidToCallId.set(uuid, callId);
  }

  private unmap(callId: string): void {
    const uuid = this.callIdToUuid.get(callId);
    this.callIdToUuid.delete(callId);
    if (uuid) this.uuidToCallId.delete(uuid);
  }

  private disable(err: unknown, label: string): void {
    console.warn(`[CallKeep] ${label} failed; disabling CallKeep`, err);
    this.enabled = false;
  }
}
