import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type IncomingCallAction = {
  callId: string;
  action: string;
  callerId: string;
  mediaType: string;
  timestamp: number;
};

export type VoipPushToken = {
  token: string;
};

export interface Spec extends TurboModule {
  requestPermission(): Promise<boolean>;
  registerVoip(): Promise<string | null>;
  getVoipToken(): Promise<string | null>;
  show(
    title: string,
    body: string,
    callId: string,
  ): Promise<boolean>;
  showIncoming(
    title: string,
    body: string,
    callId: string,
    callerId: string,
    mediaType: string,
  ): Promise<boolean>;
  cancel(callId: string): Promise<boolean>;
  cancelAll(): Promise<boolean>;
  consumePendingAction(): Promise<IncomingCallAction | null>;
  /**
   * Android: store signaling HTTP base + userId so notification Decline can
   * POST /call/reject without opening the app UI.
   */
  configureCallEndpoint(httpBaseUrl: string, userId: string): Promise<boolean>;
  /**
   * Persist short-lived reject grant from invite push for kill-state Decline.
   */
  storeRejectToken(callId: string, rejectToken: string): Promise<boolean>;
  /** iOS: register an outgoing call with CallKit (PiP controls). */
  reportOutgoingCall(callId: string, peerId: string, mediaType: string): Promise<boolean>;
  /** iOS: register an in-app answered call with CallKit when no VoIP session exists. */
  reportOngoingCall(callId: string, peerId: string, mediaType: string): Promise<boolean>;
  /** iOS: mark CallKit call connected (enables PiP mute/end controls). */
  reportCallConnected(callId: string): Promise<boolean>;
  /** iOS: allow camera capture to continue during PiP / background (iOS 16+). */
  enableBackgroundCamera(): Promise<boolean>;
  /**
   * Whether the device has a torch/flash for the given camera facing mode
   * (`user` = front, `environment` = back).
   */
  hasCameraTorch(facingMode: string): Promise<boolean>;
  /** Turn camera torch/flash on or off for the given facing mode. */
  setCameraTorch(enabled: boolean, facingMode: string): Promise<boolean>;

  readonly onVoipPushToken: CodegenTypes.EventEmitter<VoipPushToken>;
  readonly onIncomingCallAction: CodegenTypes.EventEmitter<IncomingCallAction>;
}

export default TurboModuleRegistry.get<Spec>('AlaznahCalling');
