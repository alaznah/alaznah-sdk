import type {
  CallMediaType,
  CallState,
  IceServerConfig,
  QualityTier,
  SignalingMessage,
} from '@alaznah/protocol';

export type { CallMediaType, CallState, IceServerConfig, QualityTier };

export type CallDirection = 'inbound' | 'outbound';
export type CallKind = 'direct' | 'group';

export type CallParticipant = {
  participantId: string;
  displayName?: string;
  state?: 'invited' | 'ringing' | 'joined' | 'left';
  muted?: boolean;
  videoEnabled?: boolean;
};

export type CallQualitySnapshot = {
  tier: QualityTier;
  rttMs: number | null;
  packetLoss: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  audioBitrateKbps?: number | null;
  videoBitrateKbps?: number | null;
  candidateType: string | null;
  videoEnabled: boolean;
};

export type ActiveCall = {
  /** Unique media session ID. Never reuse it as a conversation/group ID. */
  callId: string;
  /** Stable chat/room identity; allows many calls in the same conversation. */
  conversationId?: string;
  /** `group` is reserved for the future SFU-backed multi-party transport. */
  kind?: CallKind;
  /** Participant collection; `peerId` remains the direct-call compatibility field. */
  participants?: CallParticipant[];
  peerId: string;
  mediaType: CallMediaType;
  direction: CallDirection;
  state: CallState;
  localStream: MediaStreamLike | null;
  remoteStream: MediaStreamLike | null;
  muted: boolean;
  videoEnabled: boolean;
  speakerOn: boolean;
  /** Front (`user`) or back (`environment`) camera for local preview mirror. */
  facingMode?: 'user' | 'environment';
  /** Increments on camera flip so local RTCView remounts. */
  cameraGeneration?: number;
  /** True when the active camera reports a torch/flash LED. */
  torchAvailable?: boolean;
  /** Current torch/flash state for the active camera. */
  torchOn?: boolean;
  quality: CallQualitySnapshot;
  startedAt: number | null;
  endedAt: number | null;
  endReason?: string;
};

export type MediaStreamLike = {
  id: string;
  getTracks: () => MediaStreamTrackLike[];
  getAudioTracks: () => MediaStreamTrackLike[];
  getVideoTracks: () => MediaStreamTrackLike[];
  toURL?: () => string;
};

export type MediaStreamTrackLike = {
  id: string;
  kind: string;
  enabled: boolean;
  stop: () => void;
  applyConstraints?: (constraints: Record<string, unknown>) => Promise<void>;
};

export type SdkFeature =
  | 'audio'
  | 'video'
  | 'group'
  | 'recording'
  | 'screen-share';

export type SdkEntitlement = {
  projectId: string;
  plan: 'trial' | 'starter' | 'pro' | 'enterprise' | string;
  features: SdkFeature[];
  expiresAt: number;
  environment?: 'development' | 'production';
  bundleIds?: string[];
  packageNames?: string[];
  maxConcurrentCalls?: number;
  graceUntil?: number;
};

/**
 * Commercial entitlement is separate from end-user JWT auth.
 * Production apps should fetch short-lived tokens from their backend;
 * the vendor website/backend issues those after project credentials are validated.
 */
export type EntitlementProvider = {
  getEntitlement: () => Promise<SdkEntitlement> | SdkEntitlement;
};

export type CallingClientConfig = {
  /**
   * WebSocket signaling URL (self-host / enterprise override).
   * When omitted, connects to the SDK hosted default (`DEFAULT_HOSTED_SIGNALING_URL`).
   */
  signalingUrl?: string;
  /** JWT or opaque auth token verifier contract on server */
  getAuthToken: () => Promise<string> | string;
  userId: string;
  deviceId?: string;
  /** Optional static ICE servers; otherwise fetched via signaling */
  iceServers?: IceServerConfig[];
  /** Force TURN relay for connectivity diagnostics. */
  iceTransportPolicy?: 'all' | 'relay';
  /** Optional ring timeout (default 60s). Unanswered calls auto-drop. */
  ringTimeoutMs?: number;
  /**
   * Optional CallKeep / second CallKit provider for outgoing UI.
   * **Recommended: `false` on iOS** — the SDK TurboModule (PushKit + CallKit) owns incoming.
   */
  enableCallKeep?: boolean;
  callKeepOptions?: {
    appName: string;
    imageName?: string;
    supportsVideo?: boolean;
    /** Never enable on iOS Simulator — CallKit will crash the process. */
    allowIosSimulator?: boolean;
  };
  /** Prefer camera facing mode for video calls */
  facingMode?: 'user' | 'environment';
  /** Quality adaptation poll interval ms */
  statsIntervalMs?: number;
  /**
   * Paid-developer entitlement/session provider.
   * Defaults to a local development trial when omitted.
   */
  entitlementProvider?: EntitlementProvider;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

export type StartCallOptions = {
  calleeId: string;
  mediaType?: CallMediaType;
  conversationId?: string;
  kind?: CallKind;
};

export type CallingClientEvents = {
  ready: () => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
  'call:updated': (call: ActiveCall) => void;
  'call:incoming': (call: ActiveCall) => void;
  'call:ended': (call: ActiveCall) => void;
  'quality:updated': (callId: string, quality: CallQualitySnapshot) => void;
  'signaling:message': (message: SignalingMessage) => void;
  /** True while cold-starting into an accepted call (kill-state / CallKit accept). */
  'waking:for-call': (active: boolean) => void;
};

export type CallingClient = {
  connect: () => Promise<void>;
  disconnect: () => void;
  startCall: (options: StartCallOptions) => Promise<ActiveCall>;
  accept: (callId?: string) => Promise<ActiveCall>;
  reject: (callId?: string, reason?: 'busy' | 'declined' | 'unavailable') => Promise<void>;
  end: (callId?: string, reason?: string) => Promise<void>;
  setMuted: (muted: boolean, callId?: string) => Promise<void>;
  setVideoEnabled: (enabled: boolean, callId?: string) => Promise<void>;
  switchCamera: (callId?: string) => Promise<void>;
  /** Toggle camera torch/flash when `torchAvailable` is true. */
  setTorch: (enabled: boolean, callId?: string) => Promise<void>;
  setSpeaker: (enabled: boolean, callId?: string) => Promise<void>;
  getCall: (callId?: string) => ActiveCall | null;
  getActiveCall: () => ActiveCall | null;
  /** Kill-state accept path — hide host dialer until call UI is ready. */
  isWakingForCall: () => boolean;
  /** True when this callId was accepted from native / CallKit — skip JS Incoming. */
  isAutoAcceptingCall: (callId: string) => boolean;
  /**
   * Apply SharedPreferences / Intent Accept-Decline before any Incoming UI sync.
   * Call on AppState → active to prevent IncomingCallScreen flash after native Accept.
   */
  drainNativeIncomingAction: () => Promise<boolean>;
  on: <K extends keyof CallingClientEvents>(event: K, listener: CallingClientEvents[K]) => () => void;
  registerPushToken: (token: string, platform: 'ios' | 'android') => Promise<void>;
  /** Reconnect / pull pending invites after returning from background. */
  syncPendingCalls: () => Promise<void>;
  /**
   * When true, Android will not post the system incoming-call notification /
   * native ringing Activity (use while the in-app CallingUI is visible).
   */
  setNativeIncomingSuppressed: (suppressed: boolean) => void;
};
