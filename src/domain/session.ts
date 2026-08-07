import type {
  ActiveCall,
  CallKind,
  CallParticipant,
  MediaStreamLike,
} from '../types/index.js';

/**
 * Future-facing session model. Direct 1:1 calls adapt into this shape so group
 * SFU transport can reuse the same public contracts later.
 */
export type CallSession = {
  callId: string;
  conversationId?: string;
  kind: CallKind;
  participants: CallParticipant[];
  localStream: MediaStreamLike | null;
  remoteStreams: Record<string, MediaStreamLike | null>;
};

export type CallTransportKind = 'direct' | 'sfu';

export type CallTransport = {
  kind: CallTransportKind;
  start: () => Promise<void>;
  accept: () => Promise<void>;
  close: (reason?: string) => Promise<void>;
  setMuted: (muted: boolean) => void;
  setVideoEnabled: (enabled: boolean) => void;
};

export function buildDirectParticipants(
  localUserId: string,
  peerId: string,
): CallParticipant[] {
  return [
    { participantId: localUserId, state: 'joined' },
    { participantId: peerId, state: 'invited' },
  ];
}

export function toActiveCallView(
  call: ActiveCall,
  localUserId: string,
): ActiveCall {
  const participants =
    call.participants ??
    buildDirectParticipants(localUserId, call.peerId).map((p) =>
      p.participantId === call.peerId
        ? {
            ...p,
            state:
              call.state === 'connected' || call.state === 'accepted'
                ? 'joined'
                : p.state,
          }
        : p,
    );

  return {
    ...call,
    kind: call.kind ?? 'direct',
    conversationId: call.conversationId ?? call.callId,
    participants,
  };
}
