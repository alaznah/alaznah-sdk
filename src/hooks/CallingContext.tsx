import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { createCallingClient } from '../core/CallManager.js';
import type { ActiveCall, CallingClient, CallingClientConfig, CallQualitySnapshot } from '../types/index.js';

type CallingContextValue = {
  client: CallingClient;
  call: ActiveCall | null;
  incoming: ActiveCall | null;
  quality: CallQualitySnapshot | null;
  ready: boolean;
  wakingForCall: boolean;
};

const CallingContext = createContext<CallingContextValue | null>(null);

export type CallingProviderProps = {
  config: CallingClientConfig;
  children: React.ReactNode;
  autoConnect?: boolean;
};

export function CallingProvider({ config, children, autoConnect = true }: CallingProviderProps) {
  const client = useMemo(() => createCallingClient(config), [
    config.signalingUrl,
    config.userId,
    config.deviceId,
    config.enableCallKeep,
  ]);

  const [call, setCall] = useState<ActiveCall | null>(null);
  const [incoming, setIncoming] = useState<ActiveCall | null>(null);
  const [quality, setQuality] = useState<CallQualitySnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [wakingForCall, setWakingForCall] = useState(false);

  useEffect(() => {
    const offs = [
      client.on('ready', () => setReady(true)),
      client.on('disconnected', () => setReady(false)),
      client.on('call:incoming', (c) => {
        if (client.isAutoAcceptingCall(c.callId)) return;
        if (AppState.currentState !== 'active') return;
        setIncoming(c);
      }),
      client.on('call:updated', (c) => {
        setCall(c);
        if (
          c.direction === 'inbound' &&
          c.state === 'ringing' &&
          !client.isAutoAcceptingCall(c.callId) &&
          AppState.currentState === 'active'
        ) {
          setIncoming(c);
        }
        if (c.state !== 'ringing') setIncoming((prev) => (prev?.callId === c.callId ? null : prev));
      }),
      client.on('waking:for-call', (active) => {
        setWakingForCall(active);
        // Don't clear Incoming globally — only auto-accepting callIds are gated.
      }),
      client.on('call:ended', (c) => {
        setCall(c);
        setIncoming((prev) => (prev?.callId === c.callId ? null : prev));
      }),
      client.on('quality:updated', (_id, q) => setQuality(q)),
    ];

    if (autoConnect) {
      void client.connect();
    }

    return () => {
      offs.forEach((off) => off());
      client.disconnect();
    };
  }, [client, autoConnect]);

  // When the app returns from background, reconnect and pull any pending invites.
  useEffect(() => {
    if (!autoConnect) return undefined;

    const applyForeground = (next: AppStateStatus) => {
      // Foreground: JS IncomingCallScreen. Background/kill: native ringing UI.
      client.setNativeIncomingSuppressed(next === 'active');
      if (next === 'active') {
        void client
          .drainNativeIncomingAction()
          .then(() => client.connect())
          .then(() => client.syncPendingCalls())
          .catch(() => undefined);
      }
    };

    applyForeground(AppState.currentState);

    const sub = AppState.addEventListener('change', applyForeground);
    return () => {
      sub.remove();
    };
  }, [client, autoConnect]);

  const value = useMemo(
    () => ({ client, call, incoming, quality, ready, wakingForCall }),
    [client, call, incoming, quality, ready, wakingForCall],
  );

  return <CallingContext.Provider value={value}>{children}</CallingContext.Provider>;
}

function useCallingContext(): CallingContextValue {
  const ctx = useContext(CallingContext);
  if (!ctx) {
    throw new Error('Calling hooks must be used within <CallingProvider>');
  }
  return ctx;
}

export function useCallingClient(): CallingClient {
  return useCallingContext().client;
}

export function useCall(): ActiveCall | null {
  return useCallingContext().call;
}

export function useIncomingCall(): ActiveCall | null {
  return useCallingContext().incoming;
}

export function useCallQuality(): CallQualitySnapshot | null {
  return useCallingContext().quality;
}

export function useCallingReady(): boolean {
  return useCallingContext().ready;
}

export function useWakingForCall(): boolean {
  return useCallingContext().wakingForCall;
}
