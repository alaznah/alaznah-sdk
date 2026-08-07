import {
  DeviceEventEmitter,
  NativeEventEmitter,
  Platform,
  type EmitterSubscription,
} from 'react-native';
import { NativeAlaznahCalling } from './NativeAlaznahCalling.js';

export type IncomingPushPayload = {
  type?: string;
  callId: string;
  callerId?: string;
  handle?: string;
  mediaType?: 'audio' | 'video' | string;
  conversationId?: string;
};

export type NativeIncomingAction = {
  callId: string;
  action: 'accept' | 'decline' | 'open' | 'mute' | 'unmute' | 'end';
  callerId?: string;
  mediaType?: string;
  timestamp?: number;
};

type LegacyEventModule = {
  addListener?: (event: string) => void;
  removeListeners?: (count: number) => void;
};

const NATIVE_CALL_ACTIONS = new Set([
  'accept',
  'decline',
  'mute',
  'unmute',
  'end',
]);

function parseNativeAction(
  payload: Record<string, unknown>,
): NativeIncomingAction | null {
  if (typeof payload.callId !== 'string' || typeof payload.action !== 'string') {
    return null;
  }
  const raw = payload.action;
  return {
    callId: payload.callId,
    action: (NATIVE_CALL_ACTIONS.has(raw)
      ? raw
      : 'open') as NativeIncomingAction['action'],
    callerId: typeof payload.callerId === 'string' ? payload.callerId : undefined,
    mediaType: typeof payload.mediaType === 'string' ? payload.mediaType : undefined,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
  };
}

function subscribe(
  event: 'VoipPushToken' | 'IncomingCallAction',
  listener: (payload: Record<string, unknown>) => void,
): () => void {
  const module = NativeAlaznahCalling;
  if (!module) return () => undefined;

  if (event === 'VoipPushToken' && typeof module.onVoipPushToken === 'function') {
    const subscription = module.onVoipPushToken(listener as (payload: { token: string }) => void);
    return () => subscription.remove();
  }
  if (event === 'IncomingCallAction' && typeof module.onIncomingCallAction === 'function') {
    const subscription = module.onIncomingCallAction(
      listener as (payload: {
        callId: string;
        action: string;
        callerId: string;
        mediaType: string;
        timestamp: number;
      }) => void,
    );
    return () => subscription.remove();
  }

  const legacyModule = module as LegacyEventModule;
  if (typeof legacyModule.addListener !== 'function') {
    return () => undefined;
  }
  const subscription: EmitterSubscription = new NativeEventEmitter(
    legacyModule as never,
  ).addListener(event, listener);
  return () => subscription.remove();
}

/** Register PushKit and return its APNs VoIP device token (physical iOS only). */
export async function registerIosVoipToken(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const module = NativeAlaznahCalling;
  if (!module) return null;
  let token = await module.registerVoip();
  if (typeof token === 'string' && token.length > 0) return token;
  // PushKit often delivers the token shortly after registry starts.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    token = (await module.getVoipToken?.()) ?? null;
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return null;
}

export function onIosVoipToken(listener: (token: string) => void): () => void {
  if (Platform.OS !== 'ios') return () => undefined;
  return subscribe('VoipPushToken', payload => {
    if (typeof payload.token === 'string') listener(payload.token);
  });
}

export function onNativeIncomingAction(
  listener: (action: NativeIncomingAction) => void,
): () => void {
  const forward = (payload: Record<string, unknown>) => {
    const action = parseNativeAction(payload);
    if (action) listener(action);
  };
  const stopTurbo = subscribe('IncomingCallAction', forward);
  // Android IncomingCallActivity also emits via DeviceEventEmitter so Accept /
  // Decline reaches JS immediately while the host Activity is already running.
  const deviceSub = DeviceEventEmitter.addListener('IncomingCallAction', forward);
  return () => {
    stopTurbo();
    deviceSub.remove();
  };
}

export async function consumeNativeIncomingAction(): Promise<NativeIncomingAction | null> {
  const action = await NativeAlaznahCalling?.consumePendingAction();
  if (!action) return null;
  return {
    ...action,
    action: (NATIVE_CALL_ACTIONS.has(action.action)
      ? action.action
      : 'open') as NativeIncomingAction['action'],
  };
}

/**
 * Show native incoming-call UI immediately from an Android FCM headless task.
 * iOS kill-state UI is created natively by PushKit before JavaScript starts.
 */
export async function handleBackgroundIncomingCall(
  message:
    | { data?: Record<string, string | undefined> }
    | Record<string, string | undefined>,
): Promise<void> {
  const data: Record<string, string | undefined> =
    'data' in message &&
    typeof message.data === 'object' &&
    message.data !== null
      ? message.data
      : (message as Record<string, string | undefined>);
  const callId = data.callId;
  if (Platform.OS !== 'android' || !callId) return;

  const type = data.type ?? '';

  // Caller hung up / peer declined / ring timed out — stop notification + Activity.
  // NEVER fall through to showIncoming (that produced the bogus
  // "Incoming call is calling…" banner after iOS hang-up).
  if (type === 'call_canceled' || type === 'call_cancelled' || type === 'call_end') {
    try {
      await NativeAlaznahCalling?.cancel(callId);
    } catch {
      // ignore
    }
    return;
  }

  // Strict: only explicit incoming_call wakes the ringing UI.
  if (type !== 'incoming_call') return;

  // Persist decline endpoint from the push itself so kill-state Decline can
  // HTTP-reject even if configureCallEndpoint never ran in this process.
  const signalingHttp = data.signalingHttp?.trim();
  const calleeId = data.calleeId?.trim();
  if (signalingHttp && calleeId && NativeAlaznahCalling?.configureCallEndpoint) {
    try {
      await NativeAlaznahCalling.configureCallEndpoint(signalingHttp, calleeId);
    } catch {
      // still try to ring
    }
  }

  const rejectToken = data.rejectToken?.trim();
  if (rejectToken && callId && NativeAlaznahCalling?.storeRejectToken) {
    try {
      await NativeAlaznahCalling.storeRejectToken(callId, rejectToken);
    } catch {
      // Decline will fail closed without the grant
    }
  }

  const callerId = data.callerId ?? data.handle ?? 'Incoming call';
  const mediaType = data.mediaType === 'video' ? 'video' : 'audio';
  await NativeAlaznahCalling?.showIncoming(
    `Incoming ${mediaType} call`,
    `${callerId} is calling…`,
    callId,
    callerId,
    mediaType,
  );
}
