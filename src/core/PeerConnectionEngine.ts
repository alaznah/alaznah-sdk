import type { IceCandidatePayload, IceServerConfig, SdpPayload } from '@alaznah/protocol';
import { Platform } from 'react-native';
import {
  shouldResumeVideoCapture,
} from '../call/inboundMessageGuards.js';
import {
  QualityController,
  getConstraintsForTier,
  type QualityDecision,
} from '../quality/QualityController.js';
import type { CallMediaType, CallQualitySnapshot, MediaStreamLike } from '../types/index.js';
import { collectQualityStats, type StatsCollectorState } from './stats.js';
import { shouldTrickleLocalCandidate, sortIceCandidatesByPriority } from './iceCandidatePolicy.js';

/** Minimal WebRTC surface used by the engine (browser or react-native-webrtc). */
export type WebRtcAdapters = {
  RTCPeerConnection: new (config?: RTCConfiguration) => RTCPeerConnection;
  mediaDevices: {
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    enumerateDevices?: () => Promise<
      Array<{
        deviceId: string;
        kind: string;
        label?: string;
        facing?: string;
      }>
    >;
  };
  MediaStream?: new (tracks?: MediaStreamTrack[]) => MediaStream;
};

export type PeerEngineEvents = {
  onIceCandidate: (candidate: IceCandidatePayload) => void;
  onRemoteStream: (stream: MediaStreamLike) => void;
  onLocalStreamChanged?: (stream: MediaStreamLike | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onQuality: (quality: CallQualitySnapshot, decision: QualityDecision) => void;
  onError: (error: Error) => void;
  onDiagnostic?: (event: string, detail?: Record<string, unknown>) => void;
};

export type PeerEngineOptions = {
  mediaType: CallMediaType;
  iceServers: IceServerConfig[];
  facingMode?: 'user' | 'environment';
  statsIntervalMs?: number;
  /** Force TURN relay for connectivity diagnostics. */
  iceTransportPolicy?: RTCIceTransportPolicy;
  adapters: WebRtcAdapters;
  events: PeerEngineEvents;
};

/**
 * Unified Plan peer connection with trickle ICE, perfect negotiation helpers,
 * adaptive sender parameters, and ICE restart support.
 */
export class PeerConnectionEngine {
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private isPolite: boolean;
  private quality: QualityController;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly options: PeerEngineOptions;
  private iceRestartAttempts = 0;
  private pendingRemoteIce: IceCandidatePayload[] = [];
  private remoteDescriptionSet = false;
  private statsState: StatsCollectorState = {};
  private allowRelayTrickle = false;
  private statsPaused = false;
  private readonly maxIceRestartAttempts = 5;
  private audioOnlyStreak = 0;
  private videoCaptureSuspended = false;
  /** User toggled camera — adaptive quality must not override this. */
  private userCameraOn = true;
  /** Bumps only when the physical camera device changes (not every preview refresh). */
  private cameraGeneration = 0;
  /** Cached so replaceTrack(null) still finds the video sender. */
  private videoSender: RTCRtpSender | null = null;
  /** Last adaptive tier that applied capture constraints — avoid restarting the camera. */
  private lastCaptureTier: string | null = null;
  private lastVideoTxEnabled = true;
  private lastEncoding: {
    maxBitrate: number;
    scale: number;
    maxFramerate: number;
  } | null = null;

  constructor(options: PeerEngineOptions & { polite?: boolean }) {
    this.options = options;
    this.isPolite = options.polite ?? false;
    this.quality = new QualityController({
      mediaWantsVideo: options.mediaType === 'video',
      initialTier: options.mediaType === 'video' ? 'high' : 'audio-only',
      upgradeStreakRequired: 4,
    });

    this.pc = new options.adapters.RTCPeerConnection({
      iceServers: options.iceServers as RTCIceServer[],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceTransportPolicy: options.iceTransportPolicy,
    });

    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const candidateLine = ev.candidate.candidate;
      const type = this.candidateType(candidateLine);
      if (
        !shouldTrickleLocalCandidate(candidateLine, {
          allowRelay: this.allowRelayTrickle,
          forceRelay: this.options.iceTransportPolicy === 'relay',
        })
      ) {
        this.options.events.onDiagnostic?.('ice.local.deferred', { type });
        return;
      }
      this.options.events.onDiagnostic?.('ice.local', {
        candidate: candidateLine,
        type,
      });
      this.options.events.onIceCandidate({
        candidate: candidateLine,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
        usernameFragment: ev.candidate.usernameFragment,
      });
    };

    this.pc.ontrack = (ev) => {
      this.options.events.onDiagnostic?.('track.remote', {
        kind: ev.track.kind,
        id: ev.track.id,
        enabled: ev.track.enabled,
      });
      const stream =
        (ev.streams[0] as MediaStream | undefined) ?? this.ensureRemoteStream(ev.track);
      // Keep a stable stream object — re-emitting the same id remounts RTCView and blinks.
      if (this.remoteStream && this.remoteStream.id === stream.id) {
        const hasTrack = this.remoteStream.getTracks().some((t) => t.id === ev.track.id);
        if (!hasTrack) {
          try {
            this.remoteStream.addTrack(ev.track);
          } catch {
            // ignore
          }
        }
        return;
      }
      this.remoteStream = stream;
      this.options.events.onRemoteStream(stream as unknown as MediaStreamLike);
    };

    this.pc.onconnectionstatechange = () => {
      this.options.events.onDiagnostic?.('pc.connection', {
        state: this.pc.connectionState,
        ice: this.pc.iceConnectionState,
        gathering: this.pc.iceGatheringState,
      });
      this.options.events.onConnectionState(this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        this.iceRestartAttempts = 0;
        // Start quality loop as soon as media flows, including early diagnostics.
        this.startQualityLoop();
      }
    };
  }

  getLocalStream(): MediaStreamLike | null {
    return this.localStream as unknown as MediaStreamLike | null;
  }

  getFacingMode(): 'user' | 'environment' {
    return this.options.facingMode ?? 'user';
  }

  getCameraGeneration(): number {
    return this.cameraGeneration;
  }

  getRemoteStream(): MediaStreamLike | null {
    return this.remoteStream as unknown as MediaStreamLike | null;
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  getIceConnectionState(): RTCIceConnectionState {
    return this.pc.iceConnectionState;
  }

  /** Allow TURN relay trickle — call when entering ICE recovery. */
  enableIceRecovery(): void {
    this.allowRelayTrickle = true;
  }

  /** Pause quality/stats loop in background to save CPU/battery. */
  setStatsPaused(paused: boolean): void {
    this.statsPaused = paused;
  }

  async setIceServers(iceServers: IceServerConfig[]): Promise<void> {
    this.options.iceServers = iceServers;
    if (typeof this.pc.setConfiguration === 'function') {
      this.pc.setConfiguration({
        iceServers: iceServers as RTCIceServer[],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: this.options.iceTransportPolicy,
      });
    }
  }

  async acquireLocalMedia(): Promise<MediaStreamLike> {
    const wantVideo = this.options.mediaType === 'video';
    const tierConstraints = getConstraintsForTier(
      wantVideo ? this.quality.getTier() : 'audio-only',
    );
    const audio: boolean | MediaTrackConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1, max: 1 },
      // @ts-expect-error — react-native-webrtc/google constraints
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
    };
    const videoConstraints =
      wantVideo && tierConstraints.video
        ? {
            facingMode: this.options.facingMode ?? 'user',
            width: { ideal: tierConstraints.video.width, max: 1280 },
            height: { ideal: tierConstraints.video.height, max: 720 },
            frameRate: { ideal: tierConstraints.video.frameRate, max: 30 },
          }
        : false;

    const stream = await this.options.adapters.mediaDevices.getUserMedia({
      audio,
      video: videoConstraints,
    });

    this.localStream = stream;
    for (const track of stream.getTracks()) {
      this.options.events.onDiagnostic?.('track.local', {
        kind: track.kind,
        id: track.id,
        enabled: track.enabled,
      });
      const sender = this.pc.addTrack(track, stream);
      if (track.kind === 'video') {
        this.videoSender = sender;
      }
    }
    this.lastCaptureTier = this.quality.getTier();
    this.lastVideoTxEnabled = this.options.mediaType === 'video';
    await this.applyCodecPreferences();
    return stream as unknown as MediaStreamLike;
  }

  async createOffer(): Promise<SdpPayload> {
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.options.mediaType === 'video',
      });
      const sdp = this.tuneSdp(offer.sdp ?? '');
      await this.pc.setLocalDescription({ type: offer.type, sdp });
      this.options.events.onDiagnostic?.('sdp.local', {
        type: 'offer',
        hasAudio: sdp.includes('m=audio'),
        hasVideo: sdp.includes('m=video'),
      });
      return { type: 'offer', sdp };
    } finally {
      this.makingOffer = false;
    }
  }

  async createAnswer(): Promise<SdpPayload> {
    const answer = await this.pc.createAnswer();
    const sdp = this.tuneSdp(answer.sdp ?? '');
    await this.pc.setLocalDescription({ type: answer.type, sdp });
    this.options.events.onDiagnostic?.('sdp.local', {
      type: 'answer',
      hasAudio: sdp.includes('m=audio'),
      hasVideo: sdp.includes('m=video'),
    });
    return { type: 'answer', sdp };
  }

  async handleRemoteSdp(sdp: SdpPayload): Promise<SdpPayload | null> {
    const readyForOffer =
      !this.makingOffer && this.pc.signalingState === 'stable';
    const offerCollision = sdp.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.isPolite && offerCollision;
    if (this.ignoreOffer) return null;

    if (offerCollision) {
      await this.pc.setLocalDescription({ type: 'rollback' });
    }

    await this.pc.setRemoteDescription({ type: sdp.type, sdp: sdp.sdp });
    this.remoteDescriptionSet = true;
    this.options.events.onDiagnostic?.('sdp.remote', {
      type: sdp.type,
      hasAudio: sdp.sdp.includes('m=audio'),
      hasVideo: sdp.sdp.includes('m=video'),
    });
    await this.flushPendingIce();

    if (sdp.type === 'offer') {
      return this.createAnswer();
    }
    return null;
  }

  async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (this.ignoreOffer) return;
    if (!this.remoteDescriptionSet || !this.pc.remoteDescription) {
      this.pendingRemoteIce.push(candidate);
      return;
    }
    await this.applyIceCandidate(candidate);
  }

  async restartIce(): Promise<SdpPayload | null> {
    if (this.iceRestartAttempts >= this.maxIceRestartAttempts) return null;
    this.iceRestartAttempts += 1;
    this.allowRelayTrickle = true;
    if (typeof this.pc.restartIce === 'function') {
      this.pc.restartIce();
    }
    if (this.pc.signalingState === 'stable') {
      return this.createOffer();
    }
    return null;
  }

  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  async setVideoEnabled(enabled: boolean, fromUser = false): Promise<void> {
    if (fromUser) {
      this.userCameraOn = enabled;
    }
    if (this.options.mediaType !== 'video') return;

    const videoSender = this.findVideoSender();
    const wantOn = enabled && this.userCameraOn;
    const currentlyOn = (this.localStream?.getVideoTracks()[0]?.enabled ?? false) &&
      Boolean(videoSender?.track);

    if (!wantOn) {
      for (const track of this.localStream?.getVideoTracks() ?? []) {
        if (track.enabled) track.enabled = false;
      }
      // Media pause: keep the sender track attached so flip/resume stays reliable.
      // Only detach on explicit user camera-off.
      if (fromUser && videoSender) {
        try {
          await videoSender.replaceTrack(null);
        } catch {
          // ignore unstable sender state
        }
      }
      if (fromUser || currentlyOn) {
        this.notifyLocalMedia();
      }
      return;
    }

    const track = await this.ensureVideoTrack();
    if (!track) return;
    const needsReplace = Boolean(videoSender && videoSender.track !== track);
    if (!track.enabled) track.enabled = true;
    if (needsReplace && videoSender) {
      try {
        await videoSender.replaceTrack(track);
      } catch {
        // ignore
      }
    }
    if (fromUser || !currentlyOn || needsReplace) {
      this.notifyLocalMedia();
    }
  }

  /**
   * Toggle front (`user`) ↔ back (`environment`) camera.
   * Prefer deviceId from enumerateDevices — facingMode-only constraints are
   * unreliable while quality/applyConstraints also touches the track.
   */
  async switchCamera(): Promise<void> {
    if (!this.userCameraOn || this.options.mediaType !== 'video') return;
    if (!this.localStream) return;

    const track = this.localStream.getVideoTracks()[0] as
      | (MediaStreamTrack & {
          _switchCamera?: () => void;
          getSettings?: () => { facingMode?: string; deviceId?: string };
          applyConstraints?: (c: MediaTrackConstraints) => Promise<void>;
        })
      | undefined;
    if (!track || track.readyState !== 'live') {
      throw new Error('Camera flip failed — no live video track');
    }

    const settings = track.getSettings?.() ?? {};
    const currentFacing: 'user' | 'environment' =
      settings.facingMode === 'environment' || settings.facingMode === 'user'
        ? settings.facingMode
        : (this.options.facingMode ?? 'user');
    const nextFacing: 'user' | 'environment' =
      currentFacing === 'environment' ? 'user' : 'environment';

    // 1) Pick the other camera by deviceId (most reliable on iOS/Android).
    const targetDeviceId = await this.findCameraDeviceId(nextFacing, settings.deviceId);
    if (targetDeviceId && typeof track.applyConstraints === 'function') {
      try {
        await track.applyConstraints({
          deviceId: targetDeviceId,
          facingMode: nextFacing,
        } as MediaTrackConstraints);
        this.options.facingMode = nextFacing;
        this.cameraGeneration += 1;
        this.options.events.onDiagnostic?.('camera.switched', {
          method: 'deviceId',
          facingMode: nextFacing,
          deviceId: targetDeviceId,
        });
        this.notifyLocalMedia();
        return;
      } catch (err) {
        this.options.events.onDiagnostic?.('camera.switch.deviceId_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2) Official RN-WebRTC helper (applyConstraints facingMode, clears deviceId).
    if (typeof track._switchCamera === 'function') {
      try {
        track._switchCamera();
        // applyConstraints is async under the hood — give native a tick.
        await new Promise<void>((r) => setTimeout(r, 50));
        const reported = track.getSettings?.().facingMode;
        this.options.facingMode =
          reported === 'user' || reported === 'environment' ? reported : nextFacing;
        this.cameraGeneration += 1;
        this.options.events.onDiagnostic?.('camera.switched', {
          method: 'native_switchCamera',
          facingMode: this.options.facingMode,
        });
        this.notifyLocalMedia();
        return;
      } catch (err) {
        this.options.events.onDiagnostic?.('camera.switch.native_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3) applyConstraints facingMode only (must omit deviceId).
    if (typeof track.applyConstraints === 'function') {
      await track.applyConstraints({ facingMode: nextFacing } as MediaTrackConstraints);
      this.options.facingMode = nextFacing;
      this.cameraGeneration += 1;
      this.options.events.onDiagnostic?.('camera.switched', {
        method: 'facingMode',
        facingMode: nextFacing,
      });
      this.notifyLocalMedia();
      return;
    }

    throw new Error('Camera flip failed — front/back switch not supported');
  }

  private async findCameraDeviceId(
    facing: 'user' | 'environment',
    currentDeviceId?: string,
  ): Promise<string | null> {
    const enumerate = this.options.adapters.mediaDevices.enumerateDevices;
    if (!enumerate) return null;
    try {
      const devices = await enumerate();
      const cameras = devices.filter((d) => d.kind === 'videoinput');
      const match = cameras.find((d) => {
        if (currentDeviceId && d.deviceId === currentDeviceId) return false;
        const facingRaw = (d.facing ?? '').toLowerCase();
        const label = (d.label ?? '').toLowerCase();
        const isFront =
          facingRaw === 'front' ||
          facingRaw === 'user' ||
          label.includes('front') ||
          label.includes('face');
        const isBack =
          facingRaw === 'environment' ||
          facingRaw === 'back' ||
          facingRaw === 'rear' ||
          label.includes('back') ||
          label.includes('rear');
        return facing === 'user' ? isFront : isBack;
      });
      return match?.deviceId ?? null;
    } catch {
      return null;
    }
  }

  startQualityLoop(): void {
    if (this.statsTimer) return;
    // 2s is enough for adaptive bitrate and avoids encoder thrash.
    const interval = this.options.statsIntervalMs ?? 2_000;
    this.statsTimer = setInterval(() => {
      void this.tickQuality();
    }, interval);
  }

  stopQualityLoop(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async tickQuality(): Promise<void> {
    if (this.closed || this.statsPaused) return;
    try {
      const sample = await collectQualityStats(
        () => this.pc.getStats() as Promise<RTCStatsReport>,
        this.statsState,
      );
      const decision = this.quality.decide(sample);
      await this.applyDecision(decision);
      const snapshot = this.quality.toSnapshot(sample, decision.videoEnabled);
      this.options.events.onDiagnostic?.('stats', {
        audioBitrateKbps: sample.audioBitrateKbps,
        videoBitrateKbps: sample.videoBitrateKbps,
        audioPacketsReceived: sample.audioPacketsReceived,
        candidateType: sample.candidateType,
        packetLoss: sample.packetLoss,
      });
      this.options.events.onQuality(snapshot, decision);
    } catch (err) {
      this.options.events.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async applyDecision(decision: QualityDecision): Promise<void> {
    const videoSender = this.findVideoSender();
    const audioSender = this.pc.getSenders().find((s) => s.track?.kind === 'audio');

    if (audioSender) {
      try {
        const params = audioSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const encoding = params.encodings[0] as RTCRtpEncodingParameters & {
          priority?: string;
          networkPriority?: string;
        };
        const nextAudioBr = decision.audioMaxBitrateKbps * 1000;
        if (encoding.maxBitrate !== nextAudioBr) {
          encoding.maxBitrate = nextAudioBr;
          encoding.priority = 'high';
          encoding.networkPriority = 'high';
          await audioSender.setParameters(params);
        }
      } catch {
        // Platforms may reject priority fields.
      }
    }

    // Video calls: never pause/disable the camera from adaptive quality.
    // Turning tracks off/on freezes and blinks remote video.
    if (!this.userCameraOn || !decision.videoEnabled) {
      return;
    }

    if (!videoSender || decision.maxBitrateKbps <= 0) return;

    const nextEncoding = {
      maxBitrate: decision.maxBitrateKbps * 1000,
      scale: decision.scaleResolutionDownBy,
      maxFramerate: decision.maxFramerate,
    };
    const prev = this.lastEncoding;
    const encodingChanged =
      !prev ||
      prev.maxBitrate !== nextEncoding.maxBitrate ||
      prev.scale !== nextEncoding.scale ||
      prev.maxFramerate !== nextEncoding.maxFramerate;

    if (!encodingChanged) {
      return;
    }

    const params = videoSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    // Only touch maxBitrate when possible — changing scale/framerate restarts
    // the encoder on many devices and makes remote video blink.
    params.encodings[0]!.maxBitrate = nextEncoding.maxBitrate;
    if (!prev || prev.scale !== nextEncoding.scale) {
      params.encodings[0]!.scaleResolutionDownBy = nextEncoding.scale;
    }
    if (!prev || prev.maxFramerate !== nextEncoding.maxFramerate) {
      params.encodings[0]!.maxFramerate = nextEncoding.maxFramerate;
    }
    params.degradationPreference = 'maintain-resolution';
    try {
      await videoSender.setParameters(params);
      this.lastEncoding = nextEncoding;
      this.lastCaptureTier = decision.tier;
    } catch {
      // Some platforms reject setParameters during unstable states.
    }

    // Never applyConstraints from the quality loop — it restarts the camera
    // capturer on react-native-webrtc and blinks both local and remote video.
  }

  private async applyIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    try {
      await this.pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        usernameFragment: candidate.usernameFragment ?? undefined,
      });
      this.options.events.onDiagnostic?.('ice.remote', {
        type: this.candidateType(candidate.candidate),
      });
    } catch (err) {
      if (!this.ignoreOffer) {
        this.options.events.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async flushPendingIce(): Promise<void> {
    const queued = sortIceCandidatesByPriority(
      this.pendingRemoteIce.splice(0, this.pendingRemoteIce.length),
    );
    for (const candidate of queued) {
      await this.applyIceCandidate(candidate);
    }
  }

  private async applyCodecPreferences(): Promise<void> {
    // RTCRtpReceiver is not a global in React Native (Hermes); resolve it safely.
    const Receiver = (globalThis as Record<string, unknown>).RTCRtpReceiver as
      | { getCapabilities?: (kind: string) => { codecs?: RTCRtpCodec[] } | null }
      | undefined;
    if (typeof Receiver?.getCapabilities !== 'function') return;

    const transceivers = this.pc.getTransceivers?.() ?? [];
    for (const transceiver of transceivers) {
      const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind;
      if (!kind) continue;
      const caps = Receiver.getCapabilities(kind);
      if (!caps?.codecs?.length || typeof transceiver.setCodecPreferences !== 'function') {
        continue;
      }
      if (kind === 'audio') {
        const ordered = [
          ...caps.codecs.filter((c) => /opus/i.test(c.mimeType)),
          ...caps.codecs.filter((c) => !/opus/i.test(c.mimeType)),
        ];
        try {
          transceiver.setCodecPreferences(ordered);
        } catch {
          // ignore
        }
      }
      if (kind === 'video') {
        const ordered = [
          ...caps.codecs.filter((c) => /h264/i.test(c.mimeType)),
          ...caps.codecs.filter((c) => /vp8/i.test(c.mimeType)),
          ...caps.codecs.filter((c) => !/h264|vp8/i.test(c.mimeType)),
        ];
        try {
          transceiver.setCodecPreferences(ordered);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Prefer mono Opus with in-band FEC / DTX for low-bandwidth clarity.
   */
  private tuneSdp(sdp: string): string {
    return sdp
      .replace(/(a=fmtp:\d+ .*opus.*)/gi, (line) => {
        let next = line;
        if (!/stereo=/i.test(next)) next += ';stereo=0';
        else next = next.replace(/stereo=\d/i, 'stereo=0');
        if (!/useinbandfec=/i.test(next)) next += ';useinbandfec=1';
        else next = next.replace(/useinbandfec=\d/i, 'useinbandfec=1');
        // DTX off — reduces choppy gaps and background pumping on mobile.
        if (!/usedtx=/i.test(next)) next += ';usedtx=0';
        else next = next.replace(/usedtx=\d/i, 'usedtx=0');
        if (!/maxaveragebitrate=/i.test(next)) next += ';maxaveragebitrate=64000';
        else next = next.replace(/maxaveragebitrate=\d+/i, 'maxaveragebitrate=64000');
        if (!/minptime=/i.test(next)) next += ';minptime=10';
        return next;
      });
  }

  private candidateType(candidate: string): string {
    const match = / typ (\w+)/.exec(candidate);
    return match?.[1] ?? 'unknown';
  }

  private async suspendVideoCapture(): Promise<void> {
    if (this.videoCaptureSuspended || this.closed) return;
    const videoSender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    const track = videoSender?.track ?? this.localStream?.getVideoTracks()[0];
    if (track) {
      track.enabled = false;
      try {
        track.stop();
      } catch {
        // ignore
      }
      if (this.localStream) {
        try {
          this.localStream.removeTrack(track);
        } catch {
          // ignore
        }
      }
    }
    if (videoSender) {
      try {
        await videoSender.replaceTrack(null);
      } catch {
        // ignore
      }
    }
    this.videoCaptureSuspended = true;
    this.options.events.onDiagnostic?.('video.capture.suspended', {});
  }

  private async resumeVideoCapture(): Promise<void> {
    if (!this.videoCaptureSuspended || this.closed || this.options.mediaType !== 'video') {
      return;
    }
    if (!this.userCameraOn) return;
    try {
      await this.ensureVideoTrack();
      this.options.events.onDiagnostic?.('video.capture.resumed', {});
    } catch (err) {
      this.options.events.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private findVideoSender(): RTCRtpSender | undefined {
    if (this.videoSender) return this.videoSender;
    const live = this.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (live) {
      this.videoSender = live;
      return live;
    }
    // After adaptive/user detach, match the video transceiver's sender.
    const transceiver = this.pc
      .getTransceivers?.()
      ?.find(
        (t) =>
          t.receiver.track?.kind === 'video' ||
          t.sender.track?.kind === 'video' ||
          (t as { mid?: string | null }).mid === '1',
      );
    if (transceiver?.sender) {
      this.videoSender = transceiver.sender;
      return transceiver.sender;
    }
    return undefined;
  }

  private videoConstraints() {
    const tier = getConstraintsForTier(this.quality.getTier());
    if (tier.video) {
      return {
        facingMode: this.options.facingMode ?? 'user',
        width: { ideal: tier.video.width },
        height: { ideal: tier.video.height },
        frameRate: { ideal: tier.video.frameRate },
      };
    }
    return { facingMode: this.options.facingMode ?? 'user' };
  }

  private async ensureVideoTrack(): Promise<MediaStreamTrack | null> {
    const sender = this.findVideoSender();
    const existing = this.localStream?.getVideoTracks()[0];

    if (existing && existing.readyState === 'live' && sender) {
      try {
        if (sender.track !== existing) {
          await sender.replaceTrack(existing);
        }
        this.videoCaptureSuspended = false;
        existing.enabled = this.userCameraOn;
        return existing;
      } catch {
        // fall through — acquire a fresh camera track
      }
    }

    const stream = await this.options.adapters.mediaDevices.getUserMedia({
      audio: false,
      video: this.videoConstraints(),
    });
    const newTrack = stream.getVideoTracks()[0];
    if (!newTrack || !this.localStream) return null;

    for (const old of [...this.localStream.getVideoTracks()]) {
      if (old.id === newTrack.id) continue;
      try {
        this.localStream.removeTrack(old);
        old.stop();
      } catch {
        // ignore
      }
    }
    if (!this.localStream.getVideoTracks().includes(newTrack)) {
      this.localStream.addTrack(newTrack);
    }

    if (sender) {
      await sender.replaceTrack(newTrack);
    }
    this.videoCaptureSuspended = false;
    newTrack.enabled = this.userCameraOn;
    return newTrack;
  }

  private notifyLocalMedia(): void {
    this.options.events.onLocalStreamChanged?.(this.getLocalStream());
  }

  private ensureRemoteStream(track: MediaStreamTrack): MediaStream {
    if (this.remoteStream) {
      this.remoteStream.addTrack(track);
      return this.remoteStream;
    }
    const Ctor = this.options.adapters.MediaStream ?? MediaStream;
    this.remoteStream = new Ctor([track]);
    return this.remoteStream;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopQualityLoop();
    this.pendingRemoteIce = [];
    try {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.localStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      this.localStream = null;
      this.remoteStream = null;
      try {
        this.pc.close();
      } catch {
        // ignore — native PC may already be disposed
      }
    } catch {
      // ignore teardown races (common when ending video calls on iOS)
    }
  }
}
