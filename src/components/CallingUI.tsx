import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import type { ActiveCall, CallingClient } from '../types/index.js';
import {
  ActiveCallScreen,
  MinimizedCallBubble,
  resetCallFloatPositions,
} from './ActiveCallScreen.js';
import { IncomingCallScreen } from './IncomingCallScreen.js';
import { mergeTheme } from './theme.js';
import type { CallingUIProps } from './ui-types.js';
import { useAndroidPipArming } from '../native/PictureInPicture.js';

const TERMINAL = new Set(['ended', 'failed', 'rejected', 'missed', 'busy']);
const IN_CALL = new Set(['accepted', 'connecting', 'connected', 'reconnecting']);

function shouldShowIncomingCall(
  call: ActiveCall | null,
  client: CallingClient,
  suppressedCallId: string | null,
): boolean {
  if (!call || call.state !== 'ringing' || call.direction !== 'inbound') return false;
  if (suppressedCallId && call.callId === suppressedCallId) return false;
  if (client.isAutoAcceptingCall(call.callId)) return false;
  if (AppState.currentState === 'background') return false;
  return true;
}

/**
 * STATE A — normal call: RN Modal (proven layout; controls bottom, remote video).
 * STATE B — Android system PiP: same ActiveCallScreen in an Activity-sized host
 *            (explicit window width/height so flex:1 cannot collapse).
 *
 * PiP never rewrites ActiveCallScreen styles. Native enterIfEnabled notifies JS
 * first, then enters after a short frame so STATE B is mounted before the window
 * shrinks.
 */
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
  /** Android STATE B — Activity presentation for system PiP only. */
  const [androidPipPresentation, setAndroidPipPresentation] = useState(false);
  const [suppressedIncomingId, setSuppressedIncomingId] = useState<string | null>(null);
  const suppressedRef = useRef<string | null>(null);
  suppressedRef.current = suppressedIncomingId;

  const suppressIncoming = useCallback((callId: string) => {
    suppressedRef.current = callId;
    setSuppressedIncomingId(callId);
    setIncoming((prev) => (prev?.callId === callId ? null : prev));
  }, []);

  useEffect(() => {
    const syncFromClient = () => {
      const active = client.getActiveCall();
      if (!active || TERMINAL.has(active.state)) {
        setCall(null);
        setIncoming(null);
        setSuppressedIncomingId(null);
        suppressedRef.current = null;
        setAndroidPipPresentation(false);
        resetCallFloatPositions();
        return;
      }
      if (IN_CALL.has(active.state)) {
        suppressIncoming(active.callId);
      }
      setCall(active);
      setIncoming(
        shouldShowIncomingCall(active, client, suppressedRef.current) ? active : null,
      );
    };
    syncFromClient();

    const unsubs = [
      client.on('waking:for-call', () => {
        syncFromClient();
      }),
      client.on('call:incoming', (next) => {
        if (!shouldShowIncomingCall(next, client, suppressedRef.current)) return;
        setIncoming(next);
      }),
      client.on('call:updated', (next) => {
        if (IN_CALL.has(next.state)) {
          suppressIncoming(next.callId);
        }
        if (shouldShowIncomingCall(next, client, suppressedRef.current)) {
          setIncoming(next);
        } else if (next.callId === suppressedRef.current || next.state !== 'ringing') {
          setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
        }
        if (!TERMINAL.has(next.state)) {
          setCall(next);
        } else {
          setCall((prev) => (prev?.callId === next.callId ? null : prev));
          setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
          if (suppressedRef.current === next.callId) {
            setSuppressedIncomingId(null);
            suppressedRef.current = null;
          }
          setMinimized(false);
          setAndroidPipPresentation(false);
          resetCallFloatPositions();
        }
      }),
      client.on('call:ended', (next) => {
        setIncoming((prev) => (prev?.callId === next.callId ? null : prev));
        setCall((prev) => (prev?.callId === next.callId ? null : prev));
        if (suppressedRef.current === next.callId) {
          setSuppressedIncomingId(null);
          suppressedRef.current = null;
        }
        setMinimized(false);
        setAndroidPipPresentation(false);
        resetCallFloatPositions();
      }),
      client.on('error', (error) => onError?.(error)),
    ];

    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        setIncoming(null);
        return;
      }
      if (next !== 'active') return;
      void client
        .drainNativeIncomingAction()
        .catch(() => false)
        .then(() => {
          syncFromClient();
        });
    });

    return () => {
      unsubs.forEach((off) => off());
      appSub.remove();
    };
  }, [client, onError, suppressIncoming]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const pipMod = NativeModules.AlaznahCallingPip;
    if (!pipMod) return undefined;
    const emitter = new NativeEventEmitter(pipMod);
    const sub = emitter.addListener(
      'AlaznahCallingPipModeChanged',
      (payload: { active?: boolean }) => {
        setAndroidPipPresentation(Boolean(payload?.active));
      },
    );
    return () => sub.remove();
  }, []);

  const showIncoming =
    !!incoming &&
    incoming.state === 'ringing' &&
    suppressedIncomingId !== incoming.callId &&
    AppState.currentState !== 'background' &&
    !client.isAutoAcceptingCall(incoming.callId) &&
    !(call && call.callId === incoming.callId && IN_CALL.has(call.state));

  const showActive =
    !!call &&
    !TERMINAL.has(call.state) &&
    !(call.direction === 'inbound' && call.state === 'ringing' && !suppressedIncomingId) &&
    !(showIncoming && call.callId === incoming?.callId);

  const showActiveLocked =
    showActive ||
    (!!call &&
      !TERMINAL.has(call.state) &&
      suppressedIncomingId === call.callId &&
      !showIncoming);

  useEffect(() => {
    if (!showActiveLocked) {
      setMinimized(false);
      setAndroidPipPresentation(false);
    }
  }, [showActiveLocked]);

  const androidPipEligible =
    Platform.OS === 'android' &&
    !!call &&
    call.mediaType === 'video' &&
    (call.state === 'connected' || call.state === 'reconnecting') &&
    Boolean(call.remoteStream || (call.videoEnabled && call.localStream)) &&
    showActiveLocked &&
    !showIncoming;
  useAndroidPipArming(androidPipEligible);

  if (!showIncoming && !showActiveLocked) {
    return null;
  }

  const endCall = () => {
    if (!call) return;
    void client.end(call.callId).catch((e) => onError?.(e));
  };

  const beginAccept = (callId: string, run: () => void) => {
    suppressIncoming(callId);
    run();
  };

  const activeBody =
    showActiveLocked && call && !showIncoming ? (
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
          androidSystemPipActive={androidPipPresentation}
        />
      )
    ) : null;

  const incomingBody =
    showIncoming && incoming
      ? renderIncomingScreen
        ? renderIncomingScreen({
            call: incoming,
            onAccept: () =>
              beginAccept(incoming.callId, () => {
                void client.accept(incoming.callId).catch((e) => onError?.(e));
              }),
            onReject: () =>
              void client.reject(incoming.callId, 'declined').catch((e) => onError?.(e)),
          })
        : (
            <IncomingCallScreen
              call={incoming}
              theme={theme}
              backgroundColor={backgroundColor}
              backgroundImage={backgroundImage}
              slots={slots}
              onAccept={(options) => {
                beginAccept(incoming.callId, () => {
                  void client
                    .accept(incoming.callId)
                    .then(() => {
                      if (options?.videoEnabled === false) {
                        return client.setVideoEnabled(false, incoming.callId);
                      }
                      return undefined;
                    })
                    .catch((e) => onError?.(e));
                });
              }}
              onReject={() =>
                void client.reject(incoming.callId, 'declined').catch((e) => onError?.(e))
              }
            />
          )
      : null;

  const usePipActivityHost =
    Platform.OS === 'android' && androidPipPresentation && Boolean(activeBody) && !showIncoming;

  // STATE A Modal — never mount ACS while minimized (bubble needs the video sink)
  // or while Android system PiP host is active.
  const modalBody = showIncoming
    ? incomingBody
    : usePipActivityHost || minimized
      ? null
      : activeBody;
  const showCallModal = Boolean(modalBody);

  return (
    <View style={[styles.host, style]} pointerEvents="box-none">
      {usePipActivityHost ? (
        <View collapsable={false} style={styles.pipActivityHost}>
          <StatusBar barStyle="light-content" backgroundColor="#000000" translucent />
          {activeBody as React.JSX.Element}
        </View>
      ) : null}

      {modalBody ? (
        <Modal
          animationType="none"
          visible={showCallModal}
          hardwareAccelerated
          transparent={false}
          presentationStyle="overFullScreen"
          statusBarTranslucent
        >
          {/*
            Single flex root required — Modal with bare StatusBar+screen siblings
            collapses absoluteFill children (black outgoing video).
            StatusBar lives here so Incoming→Active does not remount it (Accept jump).
          */}
          <View style={styles.modalRoot}>
            <StatusBar barStyle="light-content" backgroundColor="#000000" translucent />
            <View style={styles.modalBody}>{modalBody as React.JSX.Element}</View>
          </View>
        </Modal>
      ) : null}

      {showActiveLocked && call && !showIncoming && minimized && !usePipActivityHost ? (
        <Modal
          transparent
          visible
          animationType="none"
          statusBarTranslucent
          hardwareAccelerated
          presentationStyle="overFullScreen"
        >
          <View style={styles.bubbleOverlay} pointerEvents="box-none">
            <MinimizedCallBubble
              call={call}
              onExpand={() => setMinimized(false)}
              onEnd={endCall}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
  },
  bubbleOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  modalBody: {
    flex: 1,
  },
  /**
   * STATE B — fill the Activity content view. Must NOT use fixed screen WxH:
   * a full-screen sized SurfaceView inside a PiP window crops to the top-left.
   */
  pipActivityHost: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    zIndex: 10000,
    elevation: 10000,
  },
});
