import {
  CALL_INVITE_TTL_MS,
  RECONNECT_GRACE_MS,
  createEnvelope,
  generateId,
  type IceCandidatePayload,
  type IceServerConfig,
  type ServerToClientMessage,
  type TurnCredentialsPayload,
} from '@alaznah/protocol';
import { AppState, Platform } from 'react-native';
import { isTerminalState, canTransition, transitionCallState } from '../call/CallStateMachine.js';
import { shouldIgnoreDuplicateAccept } from '../call/inboundMessageGuards.js';
import {
  CallKeepBridge,
  generateCallUuid,
  isIosSimulator,
} from '../native/CallKeepBridge.js';
import { AudioSessionController } from '../native/AudioSessionController.js';
import { IncomingCallNotifier } from '../native/IncomingCallNotifier.js';
import { requestCallPermissions } from '../native/MediaPermissions.js';
import {
  consumeNativeIncomingAction,
  onNativeIncomingAction,
  type NativeIncomingAction,
} from '../native/PushWakeBridge.js';
import { NativeAlaznahCalling } from '../native/NativeAlaznahCalling.js';
import { RingtoneController } from '../native/RingtoneController.js';
import { TorchController } from '../native/TorchController.js';
import { createNetworkMonitor } from '../native/NetworkMonitor.js';
import { createDevEntitlementProvider } from '../entitlement/DevEntitlementProvider.js';
import { assertFeatureEnabled } from '../entitlement/assertFeature.js';
import { resolveSignalingUrl } from '../config/defaults.js';
import { decideCallRecovery } from '../recovery/resyncActiveCall.js';
import { callingDebug } from '../debug/callingDebug.js';
import { SignalingClient } from '../signaling/SocketClient.js';
import type {
  ActiveCall,
  CallingClient,
  CallingClientConfig,
  CallingClientEvents,
  CallQualitySnapshot,
  SdkEntitlement,
  StartCallOptions,
} from '../types/index.js';
import { CallMetricsCollector } from '../metrics/CallMetricsCollector.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { PeerConnectionEngine } from './PeerConnectionEngine.js';
import { sortIceCandidatesByPriority } from './iceCandidatePolicy.js';
import { loadWebRtcAdapters } from './loadAdapters.js';

type InternalCall = ActiveCall & {
  engine: PeerConnectionEngine | null;
  polite: boolean;
  ringTimer?: ReturnType<typeof setTimeout> | null;
  pendingOffer?: { type: 'offer' | 'answer'; sdp: string } | null;
  pendingAnswer?: { type: 'answer'; sdp: string } | null;
  pendingIce: IceCandidatePayload[];
  /** True once PC reached `connected` — gates reconnect/ICE-restart heuristics. */
  mediaConnectedOnce?: boolean;
  iceRecovering?: boolean;
  disconnectedRecoverTimer?: ReturnType<typeof setTimeout> | null;
};

function defaultQuality(mediaType: 'audio' | 'video'): CallQualitySnapshot {
  return {
    tier: mediaType === 'video' ? 'low' : 'audio-only',
    rttMs: null,
    packetLoss: null,
    jitterMs: null,
    bitrateKbps: null,
    candidateType: null,
    videoEnabled: mediaType === 'video',
  };
}

export function createCallingClient(config: CallingClientConfig): CallingClient {
  const log = {
    debug: config.logger?.debug ?? (() => undefined),
    info: config.logger?.info ?? console.info.bind(console),
    warn: config.logger?.warn ?? console.warn.bind(console),
    error: config.logger?.error ?? console.error.bind(console),
  };

  const signalingUrl = resolveSignalingUrl(config.signalingUrl);
  const emitter = new EventEmitter<CallingClientEvents>();
  const deviceId = config.deviceId ?? `device-${generateId()}`;
  const signaling = new SignalingClient({
    url: signalingUrl,
    getAuthToken: config.getAuthToken,
    deviceId,
  });
  const callKeep = new CallKeepBridge();
  const ringtone = new RingtoneController();
  const audioSession = new AudioSessionController();
  const torch = new TorchController();
  const notifier = new IncomingCallNotifier();
  const network = createNetworkMonitor();
  const entitlementProvider =
    config.entitlementProvider ?? createDevEntitlementProvider();
  let entitlement: SdkEntitlement | null = null;
  const calls = new Map<string, InternalCall>();
  let iceServers: IceServerConfig[] = config.iceServers ?? [];
  let turnRequestInFlight: Promise<void> | null = null;
  let callKeepConfigured = false;
  let nativeActionsBound = false;
  let signalingWasAuthenticated = false;
  let messageChain = Promise.resolve();
  let stopNetwork: (() => void) | null = null;
  let stopNativeActions: (() => void) | null = null;
  let activeCallId: string | null = null;
  // Native answer/end may arrive before WebSocket recovery. Key by call ID so
  // concurrent invitations remain safe when group calling is added.
  const pendingNativeActions = new Map<string, 'accept' | 'decline'>();
  // Filled in once the public client methods are created (CallKit can fire first).
  const clientRef: { current: CallingClient | null } = { current: null };
  /** Internal-only — not exposed on public API (Sprint 8 / benchmark suite). */
  const callMetrics = new CallMetricsCollector();
  let networkRecoverTimer: ReturnType<typeof setTimeout> | null = null;
  let networkGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let networkOnlineTimer: ReturnType<typeof setTimeout> | null = null;
  let wakingForCall = false;
  let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  const setWakingForCall = (active: boolean) => {
    if (wakingForCall === active) return;
    wakingForCall = active;
    emitter.emit('waking:for-call', active);
    // Kill/background Accept: overlap permission prompts with signaling reconnect
    // so ensureEngine does not wait 2–4s after invite arrives.
    if (active && Platform.OS === 'android') {
      void requestCallPermissions('video').catch(() => undefined);
    }
  };

  /** Kill-state Accept UI when invite never arrives — clear JS spinner only.
   * Never end CallKit here (user explicitly asked; mid-accept cancel breaks kill accept). */
  let staleWakeTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStaleWakeTimer = () => {
    if (staleWakeTimer) {
      clearTimeout(staleWakeTimer);
      staleWakeTimer = null;
    }
  };

  const abandonStaleWake = (callId: string, reason: string) => {
    callingDebug('wake.abandon', { callId, reason });
    pendingNativeActions.delete(callId);
    clearStaleWakeTimer();
    setWakingForCall(false);
  };

  const scheduleStaleWakeWatch = (callId: string) => {
    clearStaleWakeTimer();
    staleWakeTimer = setTimeout(() => {
      staleWakeTimer = null;
      if (!wakingForCall) return;
      const call = calls.get(callId);
      if (!call) {
        abandonStaleWake(callId, 'no-invite');
        return;
      }
      if (isTerminalState(call.state)) {
        abandonStaleWake(callId, `terminal:${call.state}`);
        return;
      }
      if (call.state === 'accepted' || call.state === 'connected' || call.state === 'reconnecting') {
        return;
      }
      abandonStaleWake(callId, `stuck:${call.state}`);
    }, 20_000);
  };

  /** CallKit already owns this session (VoIP answer) — JS must not cancel it. */
  const callKitOwned = new Set<string>();

  const markCallKitOwned = (callId: string) => {
    callKitOwned.add(callId);
  };

  const releaseCallKitOwned = (callId: string) => {
    callKitOwned.delete(callId);
  };

  /**
   * iOS video PiP helpers after media connects.
   * Do NOT CXStartCallAction mid-call — CallKit steals AVAudioSession from WebRTC
   * and kills call audio. PiP Mic/End use the overlay + NSNotification path instead.
   * Only mark connected when CallKit already owns the call (VoIP answer).
   */
  const reportIosCallKitForPiP = (call: InternalCall) => {
    if (Platform.OS !== 'ios' || !NativeAlaznahCalling || callKeep.isEnabled) return;
    if (call.mediaType !== 'video') return;
    const native = NativeAlaznahCalling as typeof NativeAlaznahCalling & {
      reportCallConnected?: (callId: string) => Promise<boolean>;
      enableBackgroundCamera?: () => Promise<boolean>;
    };
    void native.enableBackgroundCamera?.().catch(() => undefined);

    if (callKitOwned.has(call.callId)) {
      void native.reportCallConnected?.(call.callId).catch((err: unknown) => {
        if (__DEV__) {
          console.warn('[Calling] CallKit connected mark failed', call.callId, err);
        }
      });
    }
  };

  const prepareIosVideoCall = (call: InternalCall) => {
    if (Platform.OS !== 'ios' || call.mediaType !== 'video' || !NativeAlaznahCalling) return;
    const native = NativeAlaznahCalling as typeof NativeAlaznahCalling & {
      enableBackgroundCamera?: () => Promise<boolean>;
    };
    void native.enableBackgroundCamera?.().catch(() => undefined);
  };

  const refreshEntitlement = async () => {
    entitlement = await entitlementProvider.getEntitlement();
    return entitlement;
  };

  const applyNativeAction = (action: NativeIncomingAction) => {
    if (
      action.action !== 'accept' &&
      action.action !== 'decline' &&
      action.action !== 'mute' &&
      action.action !== 'unmute' &&
      action.action !== 'end'
    ) {
      return;
    }
    callingDebug('native.action', {
      action: action.action,
      callId: action.callId,
      hasLocalCall: calls.has(action.callId),
      ready: Boolean(clientRef.current),
    });
    if (action.action === 'mute' || action.action === 'unmute') {
      if (!clientRef.current) return;
      void clientRef.current.setMuted(action.action === 'mute', action.callId).catch(() => undefined);
      return;
    }
    if (action.action === 'end') {
      if (!clientRef.current) return;
      void clientRef.current.end(action.callId).catch(() => undefined);
      return;
    }
    if (!calls.has(action.callId) || !clientRef.current) {
      pendingNativeActions.set(action.callId, action.action);
      if (action.action === 'accept') {
        markCallKitOwned(action.callId);
        setWakingForCall(true);
        scheduleStaleWakeWatch(action.callId);
      }
      return;
    }
    if (action.action === 'accept') {
      markCallKitOwned(action.callId);
      pendingNativeActions.set(action.callId, 'accept');
      // Background → Accept: call already exists as ringing and CallingUI may
      // already hold IncomingCallScreen. Flip UI to Connecting immediately.
      setWakingForCall(true);
      scheduleStaleWakeWatch(action.callId);
      const existing = calls.get(action.callId);
      if (existing?.state === 'ringing') {
        updateCall(action.callId, { state: 'accepted' });
      }
      void clientRef.current.accept(action.callId).catch((err) => {
        log.warn('native accept failed', action.callId, err);
        callingDebug('native.accept.failed', {
          callId: action.callId,
          message: err instanceof Error ? err.message : String(err),
        });
        setWakingForCall(false);
        clearStaleWakeTimer();
      });
    } else {
      void clientRef.current.reject(action.callId, 'declined').catch((err) => {
        log.warn('native decline failed', action.callId, err);
        callingDebug('native.decline.failed', {
          callId: action.callId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };

  const clearDisconnectedRecoverTimer = (call: InternalCall) => {
    if (call.disconnectedRecoverTimer) {
      clearTimeout(call.disconnectedRecoverTimer);
      call.disconnectedRecoverTimer = null;
    }
  };

  const scheduleDisconnectedRecovery = (callId: string) => {
    const call = calls.get(callId);
    if (!call?.engine || !call.mediaConnectedOnce) return;
    clearDisconnectedRecoverTimer(call);
    call.disconnectedRecoverTimer = setTimeout(() => {
      call.disconnectedRecoverTimer = null;
      const current = calls.get(callId);
      if (!current?.engine || !current.mediaConnectedOnce) return;
      if (current.state === 'reconnecting' || current.state === 'connected') {
        void recoverIce(callId);
      }
    }, 5_000);
    calls.set(callId, call);
  };

  const clearRingTimer = (call: InternalCall) => {
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
    clearDisconnectedRecoverTimer(call);
  };

  /** Unmount RTCView before native PC teardown (avoids iOS video end crashes). */
  const teardownMediaEngine = async (call: InternalCall): Promise<void> => {
    if (!call.engine) return;
    const engine = call.engine;
    call.engine = null;
    try {
      updateCall(call.callId, { localStream: null, remoteStream: null });
    } catch {
      // call may already be terminal
    }
    await delay(Platform.OS === 'ios' ? 80 : 30);
    await engine.close();
  };

  const stopAlerting = () => {
    ringtone.stop();
  };

  /** Stop ringtone + native incoming UI (CallKit / Android notification). */
  const dismissAlertingUi = (callId?: string) => {
    stopAlerting();
    if (callId && callKitOwned.has(callId)) {
      callingDebug('dismissAlertingUi.skipCallKit', { callId });
      return;
    }
    void notifier.clear(callId);
  };

  /** Stop ringtone. Optionally end native CallKit / Android notification.
   * Never cancel CallKit for VoIP-answered sessions unless force=true. */
  const clearIncomingUi = (callId?: string, opts?: { force?: boolean }) => {
    stopAlerting();
    if (callId && callKitOwned.has(callId) && !opts?.force) {
      callingDebug('clearIncomingUi.skipCallKit', { callId });
      return;
    }
    void notifier.clear(callId);
  };

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const DEFAULT_STUN_SERVERS: IceServerConfig[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  /** Prefer STUN immediately so kill-state accept is not blocked on TURN. */
  const ensureStunFallback = () => {
    if (iceServers.length === 0) {
      iceServers = DEFAULT_STUN_SERVERS;
    }
  };

  /**
   * Dead/unreachable TURN (e.g. coturn not running) makes many WebRTC stacks
   * wait ~10–15s on allocation timeout before host/srflx connects. Initial
   * PeerConnections use STUN-only; TURN is reserved for ICE recovery.
   */
  const stunOnlyIceServers = (servers: IceServerConfig[]): IceServerConfig[] => {
    const out: IceServerConfig[] = [];
    for (const server of servers) {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
        .map(String)
        .filter((url) => url.startsWith('stun:'));
      if (urls.length) out.push({ urls });
    }
    return out.length ? out : DEFAULT_STUN_SERVERS;
  };

  /** Stop alerts + route AVAudioSession to speaker before VoiceProcessing. */
  const prepareAudioForWebRtc = async (
    mediaType: 'audio' | 'video',
    callId?: string,
  ) => {
    stopAlerting();
    // CallKit already owns AVAudioSession after Answer; InCallManager.start
    // fights RTCAudioSession and often yields silent connected calls.
    const callKitOwnsAudio =
      Platform.OS === 'ios' &&
      !isIosSimulator() &&
      !!callId &&
      callKitOwned.has(callId);
    if (!callKitOwnsAudio) {
      audioSession.prepareForWebRtc(mediaType);
    } else {
      callingDebug('audio.skipInCallManager.callKit', { callId, mediaType });
    }
    // Let InCallManager / AVAudioSession settle before getUserMedia.
    // Keep Android short — kill-state accept is latency-sensitive.
    await delay(Platform.OS === 'ios' ? 50 : 20);
  };

  let connectInFlight: Promise<void> | null = null;

  const scheduleRingTimeout = (call: InternalCall) => {
    clearRingTimer(call);
    const timeoutMs = config.ringTimeoutMs ?? CALL_INVITE_TTL_MS;
    call.ringTimer = setTimeout(() => {
      void (async () => {
        const current = calls.get(call.callId);
        if (!current || isTerminalState(current.state)) return;
        stopAlerting();
        if (current.direction === 'inbound' && current.state === 'ringing') {
          try {
            await signaling.send(
              'call.reject',
              { reason: 'unavailable' },
              { callId: current.callId, to: current.peerId },
            );
          } catch {
            // ignore
          }
          await current.engine?.close();
          callKeep.end(current.callId);
          void notifier.clear(current.callId);
          updateCall(current.callId, {
            state: 'missed',
            endedAt: Date.now(),
            endReason: 'no-answer',
          });
        } else if (
          current.direction === 'outbound' &&
          (current.state === 'connecting' || current.state === 'ringing')
        ) {
          await endInternal(current.callId, 'no-answer');
        }
      })();
    }, timeoutMs);
  };

  const updateCall = (callId: string, patch: Partial<ActiveCall>): ActiveCall => {
    const current = calls.get(callId);
    if (!current) throw new Error(`Unknown call ${callId}`);
    if (patch.state && patch.state !== current.state) {
      if (!canTransition(current.state, patch.state)) {
        // Ignore late/duplicate terminal events instead of rejecting the promise.
        if (isTerminalState(current.state)) {
          log.warn('ignored state transition from terminal', current.state, '->', patch.state);
          return toPublic(current);
        }
        log.warn('invalid call state transition', current.state, '->', patch.state);
        throw new Error(`Invalid call state transition: ${current.state} -> ${patch.state}`);
      }
      patch.state = transitionCallState(current.state, patch.state);
    }
    const next: InternalCall = { ...current, ...patch, ringTimer: current.ringTimer };
    calls.set(callId, next);
    if (!isTerminalState(next.state)) {
      activeCallId = next.callId;
    } else if (activeCallId === next.callId) {
      activeCallId = null;
    }
    const publicCall = toPublic(next);
    emitter.emit('call:updated', publicCall);
    if (isTerminalState(next.state)) {
      clearRingTimer(next);
      // Force end CallKit only on real terminal (remote hangup / user reject).
      clearIncomingUi(callId, { force: true });
      clearStaleWakeTimer();
      setWakingForCall(false);
      pendingNativeActions.delete(callId);
      releaseCallKitOwned(callId);
      audioSession.stop();
      callKeep.end(callId);
      const metrics = callMetrics.finish(callId);
      if (metrics) log.debug('call.metrics', metrics);
      emitter.emit('call:ended', publicCall);
    }
    return publicCall;
  };

  const toPublic = (call: InternalCall): ActiveCall => {
    const {
      engine: _engine,
      polite: _polite,
      ringTimer: _ringTimer,
      pendingOffer: _pendingOffer,
      pendingAnswer: _pendingAnswer,
      pendingIce: _pendingIce,
      mediaConnectedOnce: _mediaConnectedOnce,
      iceRecovering: _iceRecovering,
      disconnectedRecoverTimer: _disconnectedRecoverTimer,
      ...rest
    } = call;
    return {
      ...rest,
      kind: rest.kind ?? 'direct',
      conversationId: rest.conversationId ?? rest.callId,
      participants:
        rest.participants ??
        [
          { participantId: config.userId, state: 'joined' as const },
          { participantId: rest.peerId, state: 'invited' as const },
        ],
    };
  };

  const flushQueuedIce = async (call: InternalCall, engine: PeerConnectionEngine) => {
    const queued = sortIceCandidatesByPriority(
      call.pendingIce.splice(0, call.pendingIce.length),
    );
    for (const candidate of queued) {
      await engine.addIceCandidate(candidate);
    }
  };

  const refreshTorchForCall = async (callId: string): Promise<void> => {
    const call = calls.get(callId);
    if (!call || call.mediaType !== 'video') return;
    const facing = call.facingMode ?? call.engine?.getFacingMode() ?? 'user';
    if (!call.videoEnabled) {
      if (call.torchOn) {
        try {
          await torch.setTorch(false, facing);
        } catch {
          // ignore
        }
      }
      updateCall(callId, { torchAvailable: false, torchOn: false });
      return;
    }
    const available = await torch.hasTorch(facing);
    updateCall(callId, {
      facingMode: facing,
      torchAvailable: available,
      torchOn: available ? Boolean(call.torchOn) : false,
    });
  };

  const ensureEngine = async (call: InternalCall): Promise<PeerConnectionEngine> => {
    prepareIosVideoCall(call);
    if (call.engine) return call.engine;
    const currentEntitlement = entitlement ?? (await refreshEntitlement());
    assertFeatureEnabled(
      currentEntitlement,
      call.mediaType === 'video' ? 'video' : 'audio',
    );

    const permissions = await requestCallPermissions(call.mediaType);
    if (!permissions.microphone) {
      throw new Error('Microphone permission is required for calls');
    }
    if (call.mediaType === 'video' && !permissions.camera) {
      throw new Error('Camera permission is required for video calls');
    }

    // iOS Simulator: InCallManager + speaker before VoiceProcessing
    // (react-native-webrtc#1512). Also clears any ringtone/UISound race.
    await prepareAudioForWebRtc(call.mediaType, call.callId);
    callMetrics.markEngineStart(call.callId);
    // Seed STUN so we never block getUserMedia/PC on a slow TURN round-trip.
    ensureStunFallback();
    if (!hasTurnServers()) {
      // Refresh TURN in the background for later recovery; initial PC stays STUN-only.
      void requestTurnCredentials(1_200).catch(() => undefined);
    }
    const adapters = loadWebRtcAdapters();
    const preferSpeaker =
      call.mediaType === 'video' ||
      (Platform.OS === 'ios' && isIosSimulator());
    const engine = new PeerConnectionEngine({
      mediaType: call.mediaType,
      iceServers: stunOnlyIceServers(iceServers),
      facingMode: config.facingMode,
      statsIntervalMs: config.statsIntervalMs,
      iceTransportPolicy: config.iceTransportPolicy,
      polite: call.polite,
      adapters,
      events: {
        onIceCandidate: (candidate) => {
          void signaling.send('ice', candidate, { callId: call.callId, to: call.peerId });
        },
        onRemoteStream: (stream) => {
          const current = calls.get(call.callId);
          if (current?.remoteStream?.id === stream.id) return;
          updateCall(call.callId, { remoteStream: stream });
        },
        onLocalStreamChanged: (stream) => {
          const current = calls.get(call.callId);
          if (current?.localStream?.id === stream?.id && stream != null) return;
          updateCall(call.callId, { localStream: stream });
        },
        onConnectionState: (state) => {
          log.debug('pc state', call.callId, state);
          const current = calls.get(call.callId);
          if (state === 'connected') {
            if (current) {
              current.mediaConnectedOnce = true;
              clearDisconnectedRecoverTimer(current);
            }
            callMetrics.markConnected(call.callId, null);
            const preferSpeakerOnConnect =
              call.mediaType === 'video' ||
              (Platform.OS === 'ios' && isIosSimulator());
            // Re-assert audio route after ICE connect (InCallManager can lose speaker).
            audioSession.setSpeaker(preferSpeakerOnConnect);
            updateCall(call.callId, {
              state: 'connected',
              startedAt: Date.now(),
              speakerOn: preferSpeakerOnConnect,
            });
            setWakingForCall(false);
            reportIosCallKitForPiP(call);
            engine.startQualityLoop();
          } else if (state === 'failed') {
            if (current) clearDisconnectedRecoverTimer(current);
            callMetrics.markReconnect(call.callId);
            updateCall(call.callId, { state: 'reconnecting' });
            void recoverIce(call.callId);
          } else if (state === 'disconnected' && current?.mediaConnectedOnce) {
            callMetrics.markReconnect(call.callId);
            // Stay connected during brief ICE blips; grace timer handles network loss.
            scheduleDisconnectedRecovery(call.callId);
          }
        },
        onQuality: (quality) => {
          callMetrics.updateMedia(call.callId, {
            rttMs: quality.rttMs,
            packetLoss: quality.packetLoss,
            audioBitrateKbps: quality.audioBitrateKbps,
            videoBitrateKbps: quality.videoBitrateKbps,
            tier: quality.tier,
            hasAudio: (quality.audioBitrateKbps ?? 0) > 0,
            hasVideo: quality.videoEnabled && (quality.videoBitrateKbps ?? 0) > 0,
          });
          if (quality.candidateType) {
            callMetrics.markConnected(call.callId, quality.candidateType);
          }
          const current = calls.get(call.callId);
          // Skip React updates when tier is unchanged — prevents RTCView churn.
          if (current?.quality?.tier === quality.tier) {
            current.quality = quality;
            emitter.emit('quality:updated', call.callId, quality);
            return;
          }
          updateCall(call.callId, {
            quality,
          });
          emitter.emit('quality:updated', call.callId, quality);
        },
        onError: (error) => emitter.emit('error', error),
        onDiagnostic: (event, detail) => log.debug('media', call.callId, event, detail),
      },
    });
    call.engine = engine;
    calls.set(call.callId, call);
    await engine.acquireLocalMedia();
    await flushQueuedIce(call, engine);
    audioSession.setSpeaker(preferSpeaker);
    updateCall(call.callId, {
      localStream: engine.getLocalStream(),
      videoEnabled: call.mediaType === 'video',
      speakerOn: preferSpeaker,
      facingMode: engine.getFacingMode(),
    });
    void refreshTorchForCall(call.callId);
    return engine;
  };

  const requestTurnCredentials = async (timeoutMs = 1_200): Promise<void> => {
    if (turnRequestInFlight) return turnRequestInFlight;
    turnRequestInFlight = (async () => {
      ensureStunFallback();
      await signaling.send('turn.credentials.request', {});
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), timeoutMs);
        const off = signaling.on('message', (msg) => {
          if (msg.type === 'turn.credentials') {
            applyTurnCredentials(msg.payload);
            clearTimeout(timeout);
            off();
            resolve();
          }
        });
      });
    })().finally(() => {
      turnRequestInFlight = null;
    });
    return turnRequestInFlight;
  };

  const signalingHost = (() => {
    try {
      const match = signalingUrl.match(/^wss?:\/\/([^/:]+)/i);
      const host = match?.[1] ?? '';
      if (!host || host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2') {
        return null;
      }
      return host;
    } catch {
      return null;
    }
  })();

  /** Rewrite loopback ICE URLs to the LAN signaling host; drop still-unusable ones. */
  const sanitizeIceUrl = (url: string): string | null => {
    let next = url.trim();
    if (!next) return null;
    if (signalingHost) {
      next = next.replace(/\blocalhost\b/gi, signalingHost).replace(/\b127\.0\.0\.1\b/g, signalingHost);
    }
    // Localhost / emulator-only hosts never work on a physical phone.
    if (/\blocalhost\b/i.test(next) || /\b127\.0\.0\.1\b/.test(next) || /\b10\.0\.2\.2\b/.test(next)) {
      return null;
    }
    return next;
  };

  const applyTurnCredentials = (payload: TurnCredentialsPayload): void => {
    const stun = payload.urls
      .map(sanitizeIceUrl)
      .filter((u): u is string => !!u && u.startsWith('stun:'));
    const turn = payload.urls
      .map(sanitizeIceUrl)
      .filter((u): u is string => !!u && (u.startsWith('turn:') || u.startsWith('turns:')));

    // Always keep public STUN so a bad/missing coturn never blanks ICE.
    const next: IceServerConfig[] = [...DEFAULT_STUN_SERVERS];
    if (stun.length) next.push({ urls: stun });
    if (turn.length) {
      next.push({
        urls: turn,
        username: payload.username,
        credential: payload.credential,
      });
    }
    iceServers = next;
  };

  /** Silent recovery after WS reconnect or network restore — no UI errors. */
  const resyncActiveCallSilent = (callId: string): void => {
    const call = calls.get(callId);
    if (!call?.engine) return;
    const action = decideCallRecovery({
      callId,
      state: call.state,
      mediaConnectedOnce: call.mediaConnectedOnce,
      pcState: call.engine.getConnectionState(),
      iceState: call.engine.getIceConnectionState(),
    });
    if (action === 'recover-now') {
      void recoverIce(callId);
    } else if (action === 'schedule-ice') {
      scheduleDisconnectedRecovery(callId);
    }
  };

  const recoverIce = async (callId: string): Promise<void> => {
    const call = calls.get(callId);
    if (!call?.engine || call.iceRecovering) return;
    call.iceRecovering = true;
    try {
      call.engine.enableIceRecovery();
      await requestTurnCredentials();
      // Recovery may use TURN; if coturn is down, STUN/host still remain.
      await call.engine.setIceServers(iceServers.length ? iceServers : DEFAULT_STUN_SERVERS);
      callMetrics.markIceRestart(callId);
      const offer = await call.engine.restartIce();
      if (offer) {
        await signaling.send('sdp', offer, { callId, to: call.peerId });
        // Only the side that detected failure should notify the peer once.
        await signaling.send('ice.restart', {}, { callId, to: call.peerId });
      }
    } catch (err) {
      log.warn('ICE recovery failed', err);
      if (networkGraceTimer) {
        scheduleDisconnectedRecovery(callId);
      } else {
        await endInternal(callId, 'ice-failed');
      }
    } finally {
      const latest = calls.get(callId);
      if (latest) latest.iceRecovering = false;
    }
  };

  const endInternal = async (callId: string, reason?: string): Promise<void> => {
    const call = calls.get(callId);
    if (!call || isTerminalState(call.state)) return;
    if (call.torchOn) {
      try {
        await torch.setTorch(false, call.facingMode ?? 'user');
      } catch {
        // ignore
      }
    }
    clearRingTimer(call);
    clearIncomingUi(callId, { force: true });
    releaseCallKitOwned(callId);
    const peerNotified = await notifyPeerCallEnded(callId, call.peerId, reason);
    if (!peerNotified && __DEV__) {
      log.warn('peer call.end notify failed', callId, reason);
    }
    // Drop RTCView streams before closing native PC (prevents iOS video-call crashes).
    updateCall(callId, { localStream: null, remoteStream: null });
    await delay(Platform.OS === 'ios' ? 80 : 30);
    await call.engine?.close();
    call.engine = null;
    callKeep.end(callId);
    updateCall(callId, {
      state:
        reason === 'ice-failed' || reason === 'signaling-lost'
          ? 'failed'
          : reason === 'no-answer'
            ? 'missed'
            : 'ended',
      endedAt: Date.now(),
      endReason: reason,
      localStream: null,
      remoteStream: null,
    });
    setWakingForCall(false);
    clearStaleWakeTimer();
  };

  const signalingHttpBase = (): string | null => {
    const raw = signalingUrl?.trim();
    if (!raw) return null;
    return raw
      .replace(/^wss:/i, 'https:')
      .replace(/^ws:/i, 'http:')
      .replace(/\/$/, '');
  };

  /** Prefer WS call.end; fall back to HTTP so peer still hangs up when socket is dead. */
  const pendingPeerEnds = new Map<
    string,
    { callId: string; peerId: string; reason?: string }
  >();

  const postCallEndHttp = async (
    callId: string,
    reason?: string,
  ): Promise<boolean> => {
    const base = signalingHttpBase();
    if (!base || !config.userId) return false;
    try {
      const token = await config.getAuthToken();
      const res = await fetch(`${base}/call/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          callId,
          userId: config.userId,
          reason: reason ?? 'signaling-lost',
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const flushPendingPeerEnds = async (): Promise<void> => {
    if (pendingPeerEnds.size === 0) return;
    const queued = [...pendingPeerEnds.values()];
    for (const item of queued) {
      const ok = await postCallEndHttp(item.callId, item.reason);
      if (ok) pendingPeerEnds.delete(item.callId);
    }
  };

  const notifyPeerCallEnded = async (
    callId: string,
    peerId: string,
    reason?: string,
  ): Promise<boolean> => {
    try {
      await signaling.send('call.end', { reason }, { callId, to: peerId });
      pendingPeerEnds.delete(callId);
      return true;
    } catch {
      // Socket likely down — HTTP path notifies the peer via the signaling server.
    }
    const ok = await postCallEndHttp(callId, reason);
    if (ok) {
      pendingPeerEnds.delete(callId);
      return true;
    }
    // No network yet — retry when connectivity returns so the peer is not left hanging.
    pendingPeerEnds.set(callId, { callId, peerId, reason });
    return false;
  };

  const endAllCallsSignalingLost = async (): Promise<void> => {
    const active = [...calls.values()].filter((c) => !isTerminalState(c.state));
    for (const call of active) {
      await endInternal(call.callId, 'signaling-lost');
    }
    // Best-effort: if HTTP failed offline, keep retrying once network is back.
    void flushPendingPeerEnds();
  };

  const handleServerMessage = async (message: ServerToClientMessage): Promise<void> => {
    emitter.emit('signaling:message', message);
    if (message.type !== 'ice' && message.type !== 'sdp') {
      log.debug(
        'signaling.recv',
        message.type,
        message.callId ?? '',
        (message as { payload?: { reason?: string } }).payload?.reason ?? '',
      );
    }

    switch (message.type) {
      case 'turn.credentials':
        applyTurnCredentials(message.payload);
        break;

      case 'call.invite': {
        if (!message.callId || !message.from) break;
        // Ignore duplicate redelivery of an already-tracked invite.
        if (calls.has(message.callId)) break;

        // Kill-state Accept/Decline may already be queued (or still in native prefs).
        // Resolve that BEFORE emitting UI so Decline never flashes the ringing screen
        // and Accept goes straight into the connecting UI.
        // Keep 'accept' in pendingNativeActions until accept() reads it — deleting early
        // made viaNativeCallKit=false and tore down CallKit mid-accept.
        let pendingAction = pendingNativeActions.get(message.callId);
        if (!pendingAction) {
          const fromNative = await consumeNativeIncomingAction();
          if (
            fromNative &&
            fromNative.callId === message.callId &&
            (fromNative.action === 'accept' || fromNative.action === 'decline')
          ) {
            pendingAction = fromNative.action;
            pendingNativeActions.set(message.callId, fromNative.action);
          } else if (fromNative?.callId && fromNative.callId !== message.callId) {
            // Different call — put it back into the pending map for later.
            if (fromNative.action === 'accept' || fromNative.action === 'decline') {
              pendingNativeActions.set(fromNative.callId, fromNative.action);
            }
          }
        }
        // Cold-start race: prefs/module may lag behind invite delivery — retry once.
        if (!pendingAction) {
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
          const retry = await consumeNativeIncomingAction();
          if (
            retry &&
            retry.callId === message.callId &&
            (retry.action === 'accept' || retry.action === 'decline')
          ) {
            pendingAction = retry.action;
            pendingNativeActions.set(message.callId, retry.action);
          } else if (retry?.callId && retry.callId !== message.callId) {
            if (retry.action === 'accept' || retry.action === 'decline') {
              pendingNativeActions.set(retry.callId, retry.action);
            }
          }
        }

        const startAccepted = pendingAction === 'accept';
        const call: InternalCall = {
          callId: message.callId,
          conversationId: message.payload.conversationId ?? message.callId,
          kind: message.payload.kind ?? 'direct',
          participants: [
            { participantId: config.userId, state: 'joined' },
            {
              participantId: message.from,
              displayName: message.payload.callerDisplayName,
              state: 'ringing',
            },
          ],
          peerId: message.from,
          mediaType: message.payload.mediaType,
          direction: 'inbound',
          // Pending native Accept → never land in 'ringing' for JS IncomingCallScreen.
          state: startAccepted ? 'accepted' : 'ringing',
          localStream: null,
          remoteStream: null,
          muted: false,
          videoEnabled: message.payload.mediaType === 'video',
          speakerOn: message.payload.mediaType === 'video',
          facingMode: config.facingMode ?? 'user',
          cameraGeneration: 0,
          torchAvailable: false,
          torchOn: false,
          quality: defaultQuality(message.payload.mediaType),
          startedAt: null,
          endedAt: null,
          engine: null,
          polite: true,
          pendingIce: [],
        };
        calls.set(call.callId, call);
        activeCallId = call.callId;
        callMetrics.beginCall(call.callId);

        if (message.payload.offer) {
          call.pendingOffer = message.payload.offer;
          calls.set(call.callId, call);
        }

        if (pendingAction === 'decline') {
          callingDebug('invite.applyPendingDecline', { callId: call.callId });
          pendingNativeActions.delete(call.callId);
          // Never show ringing UI — user already declined from the notification.
          await clientRef.current?.reject(call.callId, 'declined');
          break;
        }

        if (pendingAction === 'accept') {
          callingDebug('invite.applyPendingAccept', { callId: call.callId });
          markCallKitOwned(call.callId);
          clearStaleWakeTimer();
          setWakingForCall(true);
          // Show ActiveCall "Connecting…" immediately — never IncomingCallScreen.
          emitter.emit('call:updated', toPublic(call));
          scheduleRingTimeout(call);
          void signaling.send(
            'call.ringing',
            { callId: call.callId },
            { callId: call.callId, to: message.from },
          );
          try {
            await clientRef.current?.accept(call.callId);
          } catch (err) {
            log.warn('kill-state accept failed', call.callId, err);
            callingDebug('invite.accept.failed', {
              callId: call.callId,
              message: err instanceof Error ? err.message : String(err),
            });
            setWakingForCall(false);
            // Keep CallKit up; reject will force-clear if signaling requires it.
            await clientRef.current?.reject(call.callId, 'declined');
          }
          break;
        }

        const publicCall = toPublic(call);
        // Final guard: never flash Incoming if wake/accept was recorded mid-emit.
        if (
          wakingForCall ||
          callKitOwned.has(call.callId) ||
          pendingNativeActions.get(call.callId) === 'accept'
        ) {
          callingDebug('invite.suppressIncomingUi', { callId: call.callId });
          emitter.emit('call:updated', publicCall);
          break;
        }
        if (AppState.currentState === 'active') {
          emitter.emit('call:incoming', publicCall);
        }
        emitter.emit('call:updated', publicCall);
        // The SDK's native CallKit provider owns iOS ringtone/audio focus.
        // Android uses InCallManager plus the full-screen notification channel.
        // The iOS Simulator has no CallKit ringing, so the JS ringtone covers it.
        if (Platform.OS !== 'ios' || isIosSimulator()) {
          ringtone.startIncoming({ allowAudio: true });
        }
        // Foreground: in-app Modal. Background/kill: native CallKit / full-screen.
        if (AppState.currentState === 'active') {
          if (
            !wakingForCall &&
            !callKitOwned.has(call.callId) &&
            pendingNativeActions.get(call.callId) !== 'accept'
          ) {
            void notifier.clear(call.callId);
          }
        } else {
          void notifier.notifyIncoming(publicCall);
        }
        scheduleRingTimeout(call);
        await signaling.send('call.ringing', { callId: call.callId }, { callId: call.callId, to: message.from });
        break;
      }

      case 'call.ringing':
        if (message.callId) {
          const call = calls.get(message.callId);
          // WebRTC already owns audio on outbound — vibrate only, never InCallManager.
          if (call?.direction === 'outbound' && ringtone.currentMode === 'idle') {
            ringtone.startOutgoingRingback({ allowAudio: false });
          }
          updateCall(message.callId, { state: 'ringing' });
        }
        break;

      case 'call.accept': {
        if (!message.callId) break;
        const existing = calls.get(message.callId);
        if (!existing) break;
        if (shouldIgnoreDuplicateAccept(existing.state)) break;
        clearRingTimer(existing);
        dismissAlertingUi(message.callId);
        updateCall(message.callId, { state: 'accepted' });
        const call = calls.get(message.callId);
        if (call?.engine && message.payload.answer) {
          await call.engine.handleRemoteSdp(message.payload.answer);
          await flushQueuedIce(call, call.engine);
        }
        break;
      }

      case 'call.reject':
        if (message.callId) {
          pendingNativeActions.delete(message.callId);
          setWakingForCall(false);
          clearStaleWakeTimer();
          const call = calls.get(message.callId);
          if (call) clearRingTimer(call);
          clearIncomingUi(message.callId, { force: true });
          releaseCallKitOwned(message.callId);
          if (call) await teardownMediaEngine(call);
          callKeep.end(message.callId);
          void NativeAlaznahCalling?.cancel(message.callId);
          if (call && !isTerminalState(call.state)) {
            updateCall(message.callId, {
              state: message.payload.reason === 'busy' ? 'busy' : 'rejected',
              endedAt: Date.now(),
              endReason: message.payload.reason,
            });
          } else if (!call) {
            clearIncomingUi(message.callId, { force: true });
          }
        }
        break;

      case 'call.busy':
        if (message.callId) {
          const call = calls.get(message.callId);
          if (call) clearRingTimer(call);
          clearIncomingUi(message.callId);
          updateCall(message.callId, { state: 'busy', endedAt: Date.now() });
        }
        break;

      case 'call.missed':
        if (message.callId) {
          const call = calls.get(message.callId);
          if (call) clearRingTimer(call);
          clearIncomingUi(message.callId);
          if (call) await teardownMediaEngine(call);
          callKeep.end(message.callId);
          if (call && !isTerminalState(call.state)) {
            updateCall(message.callId, { state: 'missed', endedAt: Date.now() });
          }
        }
        break;

      case 'call.end':
        if (message.callId) {
          pendingNativeActions.delete(message.callId);
          setWakingForCall(false);
          clearStaleWakeTimer();
          const call = calls.get(message.callId);
          if (call) clearRingTimer(call);
          clearIncomingUi(message.callId, { force: true });
          releaseCallKitOwned(message.callId);
          if (call) await teardownMediaEngine(call);
          callKeep.end(message.callId);
          void NativeAlaznahCalling?.cancel(message.callId);
          if (call && !isTerminalState(call.state)) {
            updateCall(message.callId, {
              state: 'ended',
              endedAt: Date.now(),
              endReason: message.payload.reason,
            });
          }
        }
        break;

      case 'sdp': {
        if (!message.callId) break;
        const call = calls.get(message.callId);
        if (!call) break;
        const engine = await ensureEngine(call);
        const answer = await engine.handleRemoteSdp(message.payload);
        if (answer) {
          await signaling.send('sdp', answer, { callId: message.callId, to: call.peerId });
        }
        break;
      }

      case 'ice': {
        if (!message.callId) break;
        const call = calls.get(message.callId);
        if (!call) break;
        if (call.engine) {
          await call.engine.addIceCandidate(message.payload);
        } else {
          call.pendingIce.push(message.payload);
          calls.set(call.callId, call);
        }
        break;
      }

      case 'ice.restart': {
        if (!message.callId) break;
        const call = calls.get(message.callId);
        if (!call?.engine) break;
        try {
          call.engine.enableIceRecovery();
          await requestTurnCredentials();
          await call.engine.setIceServers(iceServers.length ? iceServers : DEFAULT_STUN_SERVERS);
          resyncActiveCallSilent(message.callId);
        } catch (err) {
          log.warn('ICE restart peer refresh failed', err);
        }
        break;
      }

      case 'error':
        emitter.emit('error', new Error(message.payload.message));
        break;

      default:
        break;
    }
  };

  signaling.on('message', (msg) => {
    messageChain = messageChain
      .then(() => handleServerMessage(msg))
      .catch((err) => {
        log.error('signaling message handler failed', err);
        emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
  });
  signaling.on('authenticated', () => {
    if (signalingWasAuthenticated) {
      void signaling.sync().catch((err) => {
        log.warn('signaling resync after reconnect failed', err);
      });
      if (activeCallId) {
        resyncActiveCallSilent(activeCallId);
      }
    }
    signalingWasAuthenticated = true;
    emitter.emit('ready');
  });
  signaling.on('close', (_code, reason) => emitter.emit('disconnected', reason));
  signaling.on('error', (err) => emitter.emit('error', err));
  signaling.on('reconnectExhausted', () => {
    log.warn('signaling reconnect exhausted — ending active calls on both sides');
    void endAllCallsSignalingLost();
  });

  const restoreSignalingAfterNetwork = async (): Promise<void> => {
    try {
      await signaling.connect();
      await signaling.sync().catch((err) => {
        log.warn('signaling sync after network restore failed', err);
      });
      await flushPendingPeerEnds();
      if (activeCallId) {
        resyncActiveCallSilent(activeCallId);
      }
    } catch (err) {
      log.warn('signaling restore after network failed', err);
    }
  };

  const hasTurnServers = () =>
    iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith('turn'));
    });

  const connectInternal = async () => {
    if (config.enableCallKeep && Platform.OS === 'ios') {
      log.warn(
        '[Calling] enableCallKeep=true adds a second CallKit provider on iOS. ' +
          'Recommended: enableCallKeep=false and use the SDK PushKit/CallKit module (AlaznahCallingManager).',
      );
    }

    // CallKit is unsupported on the iOS Simulator and will SIGSEGV the process
    // if startCall / displayIncomingCall are invoked.
    const skipCallKeepOnSimulator =
      Platform.OS === 'ios' &&
      isIosSimulator() &&
      !config.callKeepOptions?.allowIosSimulator;

    if (config.enableCallKeep && !skipCallKeepOnSimulator && !callKeepConfigured) {
      callKeepConfigured = true;
      await callKeep.setup(
        {
          appName: config.callKeepOptions?.appName ?? 'Calling',
          imageName: config.callKeepOptions?.imageName,
          supportsVideo: config.callKeepOptions?.supportsVideo ?? true,
          allowIosSimulator: config.callKeepOptions?.allowIosSimulator,
        },
        {
          onAnswer: (callId) => {
            applyNativeAction({ callId, action: 'accept' });
          },
          onEnd: (callId) => {
            if (!calls.has(callId)) {
              pendingNativeActions.set(callId, 'decline');
              return;
            }
            const existing = calls.get(callId);
            if (existing?.state === 'ringing' && existing.direction === 'inbound') {
              void client.reject(callId, 'declined');
            } else {
              void client.end(callId);
            }
          },
          onMute: (muted, callId) => {
            void client.setMuted(muted, callId);
          },
        },
      );
    } else if (config.enableCallKeep && skipCallKeepOnSimulator) {
      console.warn('[Calling] CallKeep skipped on iOS Simulator (CallKit unsupported)');
    }

    if (!nativeActionsBound) {
      nativeActionsBound = true;
      stopNativeActions?.();
      stopNativeActions = onNativeIncomingAction(applyNativeAction);
    }

    // Kill-state Accept: pull the pending action BEFORE slow permission / TURN
    // work so invite handling can accept the moment auth flushes the invite.
    let pendingAction = await consumeNativeIncomingAction();
    if (!pendingAction) {
      // TurboModule / prefs may not be ready on the first tick after cold start.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      pendingAction = await consumeNativeIncomingAction();
    }
    if (pendingAction) applyNativeAction(pendingAction);
    const fastAccept = pendingAction?.action === 'accept';
    if (fastAccept && pendingAction?.callId) {
      markCallKitOwned(pendingAction.callId);
      setWakingForCall(true);
      scheduleStaleWakeWatch(pendingAction.callId);
    } else if (pendingAction?.action === 'decline' && pendingAction.callId) {
      setWakingForCall(false);
    }

    // Notification permission can wait — do not block accept path.
    if (fastAccept) {
      void notifier.prepare().catch(() => undefined);
    } else {
      await notifier.prepare();
    }

    // Kill/background Decline can POST /call/reject before JS connects (iOS + Android).
    if (NativeAlaznahCalling?.configureCallEndpoint) {
      const httpBase = signalingUrl
        .replace(/^wss:/i, 'https:')
        .replace(/^ws:/i, 'http:')
        .replace(/\/$/, '');
      void NativeAlaznahCalling.configureCallEndpoint(httpBase, config.userId).catch(() => undefined);
      callingDebug('configureCallEndpoint', { httpBase, userId: config.userId });
    }

    if (!appStateSubscription) {
      appStateSubscription = AppState.addEventListener('change', (nextState) => {
        const background = nextState === 'background' || nextState === 'inactive';
        for (const call of calls.values()) {
          if (!call.engine || isTerminalState(call.state)) continue;
          // Keep quality loop alive during active calls — pausing caused false downgrades.
          if (background && call.state !== 'connected' && call.state !== 'reconnecting') {
            call.engine.setStatsPaused(true);
          } else {
            call.engine.setStatsPaused(false);
          }
        }
      });
    }

    if (!stopNetwork) {
      stopNetwork = network.start((state) => {
        const online =
          state.isConnected &&
          (state.isInternetReachable === true || state.isInternetReachable === null);

        if (!online) {
          if (networkOnlineTimer) {
            clearTimeout(networkOnlineTimer);
            networkOnlineTimer = null;
          }
          if (!activeCallId) return;
          const call = calls.get(activeCallId);
          if (!call?.engine || !call.mediaConnectedOnce) return;
          if (networkRecoverTimer) {
            clearTimeout(networkRecoverTimer);
            networkRecoverTimer = null;
          }
          if (!networkGraceTimer) {
            networkGraceTimer = setTimeout(() => {
              networkGraceTimer = null;
              const id = activeCallId;
              if (!id) return;
              const current = calls.get(id);
              if (!current?.engine || !current.mediaConnectedOnce) return;
              callMetrics.markReconnect(id);
              updateCall(id, { state: 'reconnecting' });
              scheduleDisconnectedRecovery(id);
            }, RECONNECT_GRACE_MS);
          }
          return;
        }

        // Network is back — always rejoin signaling (even with no active call).
        // This recovers after "reconnect attempts exhausted" without requiring an app reload.
        if (networkOnlineTimer) clearTimeout(networkOnlineTimer);
        networkOnlineTimer = setTimeout(() => {
          networkOnlineTimer = null;
          void restoreSignalingAfterNetwork();
        }, 700);

        if (!activeCallId) return;
        const call = calls.get(activeCallId);
        if (!call?.engine || !call.mediaConnectedOnce) return;
        if (call.state === 'reconnecting' || call.state === 'connected') {
          if (networkGraceTimer) {
            clearTimeout(networkGraceTimer);
            networkGraceTimer = null;
          }
          if (networkRecoverTimer) clearTimeout(networkRecoverTimer);
          networkRecoverTimer = setTimeout(() => {
            networkRecoverTimer = null;
            const id = activeCallId;
            if (id) resyncActiveCallSilent(id);
          }, 600);
        }
      });
    }

    void refreshEntitlement().catch(() => undefined);
    ensureStunFallback();

    // Signaling first — auth flush delivers the pending invite immediately.
    await signaling.connect();
    await signaling.sync();

    // Do NOT abandon wake immediately after sync — invite handling is async on
    // the message chain and can arrive shortly after sync() returns. Killing
    // CallKit here was racing real kill-state Accept. scheduleStaleWakeWatch
    // covers the true "caller already hung up" case.

    // TURN in parallel / background so accept is not blocked ~1–3s.
    if (!config.iceServers?.length && !hasTurnServers()) {
      if (fastAccept) {
        void requestTurnCredentials(1_200).catch(() => undefined);
      } else {
        await requestTurnCredentials(1_200);
      }
    }
  };

  const client: CallingClient = {
    async connect() {
      if (connectInFlight) return connectInFlight;
      connectInFlight = (async () => {
        try {
          await connectInternal();
        } finally {
          connectInFlight = null;
        }
      })();
      return connectInFlight;
    },

    disconnect() {
      stopNetwork?.();
      stopNetwork = null;
      appStateSubscription?.remove();
      appStateSubscription = null;
      if (networkRecoverTimer) {
        clearTimeout(networkRecoverTimer);
        networkRecoverTimer = null;
      }
      if (networkGraceTimer) {
        clearTimeout(networkGraceTimer);
        networkGraceTimer = null;
      }
      if (networkOnlineTimer) {
        clearTimeout(networkOnlineTimer);
        networkOnlineTimer = null;
      }
      setWakingForCall(false);
      clearStaleWakeTimer();
      stopNativeActions?.();
      stopNativeActions = null;
      clearIncomingUi();
      audioSession.stop();
      for (const call of calls.values()) {
        clearRingTimer(call);
        void call.engine?.close();
      }
      calls.clear();
      signaling.disconnect();
      emitter.emit('disconnected', 'client');
    },

    async startCall(options: StartCallOptions) {
      const mediaType = options.mediaType ?? 'audio';
      // CallKeep/CallKit require RFC4122 UUIDs for call identifiers.
      const callId = generateCallUuid();
      const call: InternalCall = {
        callId,
        conversationId: options.conversationId ?? callId,
        kind: options.kind ?? 'direct',
        participants: [
          { participantId: config.userId, state: 'joined' },
          { participantId: options.calleeId, state: 'invited' },
        ],
        peerId: options.calleeId,
        mediaType,
        direction: 'outbound',
        state: 'connecting',
        localStream: null,
        remoteStream: null,
        muted: false,
        videoEnabled: mediaType === 'video',
        speakerOn: mediaType === 'video',
        facingMode: config.facingMode ?? 'user',
        cameraGeneration: 0,
        torchAvailable: false,
        torchOn: false,
        quality: defaultQuality(mediaType),
        startedAt: null,
        endedAt: null,
        engine: null,
        polite: false,
        pendingIce: [],
      };
      calls.set(callId, call);
      activeCallId = callId;
      callMetrics.beginCall(callId);
      scheduleRingTimeout(call);

      // Media + SDP first with speaker audio session (avoids iOS sim abort).
      // CallKit for PiP controls is registered when media reaches `connected`
      // (see onConnectionState) — starting it here races WebRTC audio and fails.
      const engine = await ensureEngine(call);
      if (callKeep.isEnabled) {
        callKeep.startOutgoing(toPublic(call));
      }
      const offer = await engine.createOffer();
      await signaling.send(
        'call.invite',
        {
          calleeId: options.calleeId,
          mediaType,
          offer,
          conversationId: options.conversationId ?? callId,
          kind: options.kind ?? 'direct',
          callerDisplayName: config.userId,
        },
        {
          callId,
          to: options.calleeId,
          from: config.userId,
          expiresAt: Date.now() + (config.ringTimeoutMs ?? CALL_INVITE_TTL_MS),
        },
      );
      // Android vibrate-only; iOS stays silent (fullscreen UI covers UX).
      if (Platform.OS === 'android') {
        ringtone.startOutgoingRingback({ allowAudio: false });
      }
      // The server's `call.ringing` may already have been processed; don't force
      // a `connecting` transition backwards (ringing -> connecting is invalid).
      return toPublic(calls.get(callId) ?? call);
    },

    async accept(callId) {
      const id = callId ?? activeCallId;
      if (!id) throw new Error('No call to accept');
      const call = calls.get(id);
      if (!call) throw new Error(`Unknown call ${id}`);
      clearRingTimer(call);
      const viaNativeCallKit =
        pendingNativeActions.get(id) === 'accept' || callKitOwned.has(id);
      stopAlerting();
      if (!viaNativeCallKit) {
        void notifier.clear(id);
        // CallKit PiP session starts when media connects (onConnectionState).
      } else {
        markCallKitOwned(id);
        callingDebug('accept.viaCallKit', { callId: id });
      }

      // Transition to accepted before media setup so call:updated never re-opens
      // IncomingCallScreen while ensureEngine acquires local streams.
      if (call.state === 'ringing' || call.state === 'connecting') {
        updateCall(id, { state: 'accepted' });
      }

      const engine = await ensureEngine(call);
      if (viaNativeCallKit) {
        pendingNativeActions.delete(id);
      }
      if (call.pendingOffer) {
        const answerFromOffer = await engine.handleRemoteSdp(call.pendingOffer);
        call.pendingOffer = null;
        if (answerFromOffer?.type === 'answer') {
          call.pendingAnswer = { type: 'answer', sdp: answerFromOffer.sdp };
        }
      }
      let answer: { type: 'answer'; sdp: string } | undefined = call.pendingAnswer ?? undefined;
      if (!answer) {
        try {
          const created = await engine.createAnswer();
          answer = { type: 'answer', sdp: created.sdp };
        } catch {
          // Remote offer may arrive later via `sdp`; answer will be sent then.
        }
      }
      call.pendingAnswer = null;
      await flushQueuedIce(call, engine);

      await signaling.send(
        'call.accept',
        { answer },
        { callId: id, to: call.peerId },
      );
      const current = calls.get(id);
      if (current && (current.state === 'ringing' || current.state === 'connecting')) {
        return updateCall(id, { state: 'accepted' });
      }
      return toPublic(current ?? call);
    },

    async reject(callId, reason = 'declined') {
      const id = callId ?? activeCallId;
      if (!id) return;
      pendingNativeActions.delete(id);
      clearStaleWakeTimer();
      setWakingForCall(false);
      const call = calls.get(id);
      if (!call) {
        callingDebug('reject.withoutLocalCall', { callId: id, reason });
        clearIncomingUi(id, { force: true });
        releaseCallKitOwned(id);
        callKeep.end(id);
        void NativeAlaznahCalling?.cancel(id);
        return;
      }
      clearRingTimer(call);
      clearIncomingUi(id, { force: true });
      releaseCallKitOwned(id);
      try {
        await signaling.send('call.reject', { reason }, { callId: id, to: call.peerId });
      } catch (err) {
        log.warn('call.reject send failed', id, err);
      }
      await teardownMediaEngine(call);
      callKeep.end(id);
      void NativeAlaznahCalling?.cancel(id);
      updateCall(id, { state: reason === 'busy' ? 'busy' : 'rejected', endedAt: Date.now(), endReason: reason });
    },

    async end(callId, reason) {
      const id = callId ?? activeCallId;
      if (!id) return;
      await endInternal(id, reason);
    },

    async setMuted(muted, callId) {
      const id = callId ?? activeCallId;
      if (!id) return;
      const call = calls.get(id);
      if (!call) return;
      call.engine?.setMuted(muted);
      callKeep.setMuted(id, muted);
      updateCall(id, { muted });
    },

    async setVideoEnabled(enabled, callId) {
      const id = callId ?? activeCallId;
      if (!id) return;
      const call = calls.get(id);
      if (!call?.engine) return;
      if (!enabled && call.torchOn) {
        try {
          await torch.setTorch(false, call.facingMode ?? 'user');
        } catch {
          // ignore
        }
      }
      await call.engine.setVideoEnabled(enabled, true);
      updateCall(id, {
        videoEnabled: enabled,
        localStream: call.engine.getLocalStream(),
        torchOn: enabled ? call.torchOn : false,
      });
      await refreshTorchForCall(id);
    },

    async switchCamera(callId) {
      const id = callId ?? activeCallId;
      if (!id) return;
      const call = calls.get(id);
      if (!call?.engine) return;
      // Torch is per-camera — turn off before flip, then re-probe the new lens.
      if (call.torchOn) {
        try {
          await torch.setTorch(false, call.facingMode ?? 'user');
        } catch {
          // ignore
        }
      }
      await call.engine.switchCamera();
      updateCall(id, {
        videoEnabled: call.engine.getLocalStream()?.getVideoTracks()[0]?.enabled ?? call.videoEnabled,
        localStream: call.engine.getLocalStream(),
        facingMode: call.engine.getFacingMode(),
        cameraGeneration: call.engine.getCameraGeneration(),
        torchOn: false,
      });
      await refreshTorchForCall(id);
    },

    async setTorch(enabled, callId) {
      const id = callId ?? activeCallId;
      if (!id) return;
      const call = calls.get(id);
      if (!call || call.mediaType !== 'video' || !call.videoEnabled) return;
      const facing = call.facingMode ?? call.engine?.getFacingMode() ?? 'user';
      const available = call.torchAvailable ?? (await torch.hasTorch(facing));
      if (!available) {
        updateCall(id, { torchAvailable: false, torchOn: false });
        return;
      }
      const on = await torch.setTorch(enabled, facing);
      updateCall(id, { torchAvailable: true, torchOn: on, facingMode: facing });
    },

    async setSpeaker(enabled, callId) {
      const id = callId ?? activeCallId;
      if (!id) return;
      const call = calls.get(id);
      if (!call) return;
      audioSession.setSpeaker(enabled);
      updateCall(id, { speakerOn: enabled });
    },

    getCall(callId) {
      const id = callId ?? activeCallId;
      if (!id) return null;
      const call = calls.get(id);
      return call ? toPublic(call) : null;
    },

    getActiveCall() {
      return activeCallId ? client.getCall(activeCallId) : null;
    },

    isWakingForCall() {
      return wakingForCall;
    },

    isAutoAcceptingCall(callId) {
      return (
        pendingNativeActions.get(callId) === 'accept' || callKitOwned.has(callId)
      );
    },

    async drainNativeIncomingAction() {
      const pendingAction = await consumeNativeIncomingAction();
      if (!pendingAction) return false;
      callingDebug('drainNativeIncomingAction', pendingAction);
      applyNativeAction(pendingAction);
      if (pendingAction.action === 'accept') {
        setWakingForCall(true);
        scheduleStaleWakeWatch(pendingAction.callId);
        return true;
      }
      return false;
    },

    on(event, listener) {
      return emitter.on(event, listener);
    },

    async registerPushToken(token, platform) {
      await signaling.send('push.register', { token, platform });
    },

    async syncPendingCalls() {
      await signaling.sync();
      const pendingAction = await consumeNativeIncomingAction();
      if (pendingAction) {
        callingDebug('syncPendingCalls.action', pendingAction);
        applyNativeAction(pendingAction);
        if (pendingAction.action === 'accept') {
          setWakingForCall(true);
          scheduleStaleWakeWatch(pendingAction.callId);
        }
      } else if (wakingForCall) {
        // Keep wake UI while Accept is queued or CallKit/owned — do not clear
        // before the invite arrives (that caused JS IncomingCallScreen flash).
        const hasQueuedAccept =
          [...pendingNativeActions.values()].includes('accept') || callKitOwned.size > 0;
        if (hasQueuedAccept) return;
        const active = activeCallId ? calls.get(activeCallId) : null;
        if (!active || isTerminalState(active.state)) {
          clearStaleWakeTimer();
          setWakingForCall(false);
        }
      }
    },

    setNativeIncomingSuppressed(suppressed) {
      notifier.setSuppressNative(suppressed);
    },
  };

  clientRef.current = client;
  return client;
}

/** Exported for tests that need envelope helpers without connecting. */
export { createEnvelope };
