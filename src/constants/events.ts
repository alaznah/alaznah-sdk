export const ClientEvents = {
  CallIncoming: 'call:incoming',
  CallUpdated: 'call:updated',
  CallEnded: 'call:ended',
  QualityUpdated: 'quality:updated',
  Error: 'error',
  Connected: 'connected',
  Disconnected: 'disconnected',
} as const;

export const SignalingEvents = {
  CallInvite: 'call.invite',
  CallAccept: 'call.accept',
  CallReject: 'call.reject',
  CallEnd: 'call.end',
  Sdp: 'sdp',
  Ice: 'ice',
} as const;
