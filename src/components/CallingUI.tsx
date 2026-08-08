import React, { useEffect, useState } from 'react';
import { AppState, Modal, StyleSheet, View } from 'react-native';
import type { ActiveCall, CallingClient } from '../types/index.js';
import { ActiveCallScreen, MinimizedCallBubble } from './ActiveCallScreen.js';
import { IncomingCallScreen } from './IncomingCallScreen.js';
import { mergeTheme } from './theme.js';
import type { CallingUIProps } from './ui-types.js';

const TERMINAL = new Set(['ended', 'failed', 'rejected', 'missed', 'busy']);

function shouldShowIncomingCall(
  call: ActiveCall | null,
  client: CallingClient,
): boolean {
  if (!call || call.state !== 'ringing' || call.direction !== 'inbound') return false;
  // Only suppress Incoming for the call that was Accept'd from native/CallKit.
  // A stale wake for another callId must not hide a new foreground invite.
  if (client.isAutoAcceptingCall(call.callId)) return false;
  if (AppState.currentState !== 'active') return false;
  return true;
}

export function CallingUI({
  client,
  theme: themePartial,
  backgroundColor,
  backgroundImage,
  slots,
  renderIncomingScreen,
  renderActiveCallScreen,
  style,
  onError,
}: CallingUIProps) {
  const theme = mergeTheme(themePartial);
  const [call, setCall] = useState<ActiveCall | null>(client.getActiveCall());
  const [incoming, setIncoming] = useState<ActiveCall | null>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    const syncFromClient = () => {
      const active = client.getActiveCall();
      if (!active || TERMINAL.has(active.state)) {
        setCall(null);
        setIncoming(null);
        return;
      }
      setCall(active);
      setIncoming(shouldShowIncomingCall(active, client) ? active : null);
    };
    syncFromClient();
    const catchUp = setTimeout(syncFromClient, 300);

    const unsubs = [
      client.on('waking:for-call', () => {
        syncFromClient();
      }),
      client.on('call:incoming', (next) => {
        if (!shouldShowIncomingCall(next, client)) return;
        setIncoming(next);
      }),
      client.on('call:updated', (next) => {
        if (shouldShowIncomingCall(next, client)) {
          setIncoming(next);
        } else {
          setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
        }
        if (!TERMINAL.has(next.state)) {
          setCall(next);
        } else {
          setCall((prev) => (prev?.callId === next.callId ? null : prev));
          setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
          setMinimized(false);
        }
      }),
      client.on('call:ended', (next) => {
        setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
        setCall((prev) => (prev?.callId === next.callId ? null : prev));
        setMinimized(false);
      }),
      client.on('error', (error) => onError?.(error)),
    ];

    const appSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        setIncoming(null);
        return;
      }
      void client
        .drainNativeIncomingAction()
        .catch(() => false)
        .then(() => {
          syncFromClient();
        });
    });

    return () => {
      clearTimeout(catchUp);
      unsubs.forEach((off) => off());
      appSub.remove();
    };
  }, [client, onError]);

  const showIncoming =
    !!incoming &&
    incoming.state === 'ringing' &&
    AppState.currentState === 'active' &&
    !client.isAutoAcceptingCall(incoming.callId) &&
    !(
      call &&
      call.callId === incoming.callId &&
      ['accepted', 'connecting', 'connected', 'reconnecting'].includes(call.state)
    );

  // Never show ActiveCallScreen for inbound ringing — that replaced Accept UI.
  const showActive =
    !!call &&
    !TERMINAL.has(call.state) &&
    !(call.direction === 'inbound' && call.state === 'ringing') &&
    !(showIncoming && call.callId === incoming?.callId);

  useEffect(() => {
    if (!showActive) setMinimized(false);
  }, [showActive]);

  if (!showIncoming && !showActive) {
    return null;
  }

  const endCall = () => {
    if (!call) return;
    void client.end(call.callId).catch((e) => onError?.(e));
  };

  return (
    <View style={[styles.host, style]} pointerEvents="box-none">
      {showIncoming && incoming ? (
        <Modal animationType="none" visible hardwareAccelerated presentationStyle="fullScreen">
          {(
            renderIncomingScreen ? (
              renderIncomingScreen({
                call: incoming,
                onAccept: () => void client.accept(incoming.callId).catch((e) => onError?.(e)),
                onReject: () =>
                  void client.reject(incoming.callId, 'declined').catch((e) => onError?.(e)),
              })
            ) : (
              <IncomingCallScreen
                call={incoming}
                theme={theme}
                backgroundColor={backgroundColor}
                backgroundImage={backgroundImage}
                slots={slots}
                onAccept={(options) => {
                  void client
                    .accept(incoming.callId)
                    .then(() => {
                      if (options?.videoEnabled === false) {
                        return client.setVideoEnabled(false, incoming.callId);
                      }
                      return undefined;
                    })
                    .catch((e) => onError?.(e));
                }}
                onReject={() =>
                  void client.reject(incoming.callId, 'declined').catch((e) => onError?.(e))
                }
              />
            )
          ) as React.JSX.Element}
        </Modal>
      ) : null}

      {showActive && call && !showIncoming ? (
        minimized ? (
          <MinimizedCallBubble
            call={call}
            onExpand={() => setMinimized(false)}
            onEnd={endCall}
          />
        ) : (
          <Modal animationType="fade" visible hardwareAccelerated presentationStyle="fullScreen">
            {(
              renderActiveCallScreen ? (
                renderActiveCallScreen({
                  call,
                  onEnd: endCall,
                })
              ) : (
                <ActiveCallScreen
                  call={call}
                  client={client}
                  theme={theme}
                  backgroundColor={backgroundColor}
                  backgroundImage={backgroundImage}
                  slots={slots}
                  onEnd={endCall}
                  onError={onError}
                  onMinimize={() => setMinimized(true)}
                />
              )
            ) as React.JSX.Element}
          </Modal>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { ...StyleSheet.absoluteFillObject },
});
