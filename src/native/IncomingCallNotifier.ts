import { AppState, PermissionsAndroid, Platform } from 'react-native';
import type { ActiveCall } from '../types/index.js';
import { isIosSimulator } from './CallKeepBridge.js';
import { NativeAlaznahCalling } from './NativeAlaznahCalling.js';

/**
 * System-level incoming call alert when the RN Modal is not visible
 * (background / lock screen). Complements CallKit on iOS.
 */
export class IncomingCallNotifier {
  private native = NativeAlaznahCalling;
  private permissionReady = false;
  /** Host can force-skip native alerts while the in-app UI owns the call. */
  private suppressNative = false;

  setSuppressNative(suppress: boolean): void {
    this.suppressNative = suppress;
  }

  async prepare(): Promise<void> {
    if (!this.native) return;
    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      await this.native.requestPermission();
      this.permissionReady = true;
    } catch (err) {
      console.warn('[IncomingCallNotifier] permission failed', err);
    }
  }

  async notifyIncoming(call: ActiveCall): Promise<void> {
    if (!this.native) return;
    // CallKit on the iOS Simulator cannot ring: the CallKit host immediately
    // commits a CXEndCallAction, which we would translate into a "decline" and
    // auto-reject the call. The in-app JS incoming screen covers simulator UX.
    if (Platform.OS === 'ios' && isIosSimulator()) return;
    // Foreground / in-app UI: never post native ringing (avoids duplicate Accept UI).
    if (this.suppressNative) return;
    if (AppState.currentState === 'active') return;
    if (AppState.currentState !== 'background') return;
    if (!this.permissionReady) {
      await this.prepare();
    }
    try {
      const media = call.mediaType === 'video' ? 'Video' : 'Audio';
      const title = `Incoming ${media} call`;
      const body = `${call.peerId} is calling…`;
      await this.native.showIncoming(title, body, call.callId, call.peerId, call.mediaType);
    } catch (err) {
      console.warn('[IncomingCallNotifier] show failed', err);
    }
  }

  async clear(callId?: string): Promise<void> {
    if (!this.native) return;
    try {
      if (callId) await this.native.cancel(callId);
      else await this.native.cancelAll();
    } catch {
      // ignore
    }
  }

  async consumePendingAction(): Promise<{
    callId: string;
    action: string;
    callerId?: string;
    mediaType?: string;
  } | null> {
    if (!this.native) return null;
    try {
      return await this.native.consumePendingAction();
    } catch {
      return null;
    }
  }

  /** True when the in-app Modal would not be seen. */
  static isAppObscured(): boolean {
    return AppState.currentState === 'background';
  }
}
