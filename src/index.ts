export { createCallingClient } from './core/CallManager.js';
export {
  consumeNativeIncomingAction,
  handleBackgroundIncomingCall,
  onIosVoipToken,
  onNativeIncomingAction,
  registerIosVoipToken,
  type IncomingPushPayload,
  type NativeIncomingAction,
} from './native/PushWakeBridge.js';
export {
  requestCallPermissions,
  type CallPermissionMode,
  type MediaPermissionResult,
} from './native/MediaPermissions.js';
export { createDevEntitlementProvider } from './entitlement/DevEntitlementProvider.js';
export {
  assertEntitlementActive,
  assertFeatureEnabled,
  EntitlementError,
} from './entitlement/assertFeature.js';
export {
  buildDirectParticipants,
  createDirectPeerTransport,
  type CallSession,
  type CallTransport,
} from './domain/public.js';
export { canTransition, transitionCallState, isTerminalState } from './call/CallStateMachine.js';
export {
  CallingProvider,
  useCallingClient,
  useCall,
  useIncomingCall,
  useCallQuality,
  useCallingReady,
  useWakingForCall,
} from './hooks/CallingContext.js';
export { CallingScreen, type CallingScreenProps } from './components/CallingScreen.js';
export { CallingUI } from './components/CallingUI.js';
export type { CallingUIProps, CallingUISlots } from './components/ui-types.js';
export { VideoView, LocalVideoView, RemoteVideoView } from './components/VideoView.js';
export type {
  ActiveCall,
  CallingClient,
  CallingClientConfig,
  CallingClientEvents,
  CallDirection,
  CallKind,
  CallMediaType,
  CallParticipant,
  CallQualitySnapshot,
  CallState,
  EntitlementProvider,
  IceServerConfig,
  MediaStreamLike,
  QualityTier,
  SdkEntitlement,
  SdkFeature,
  StartCallOptions,
} from './types/index.js';
export { DEFAULT_HOSTED_SIGNALING_URL } from './config/defaults.js';
export { PROTOCOL_VERSION, PROTOCOL_MAJOR } from '@alaznah/protocol';
