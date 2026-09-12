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
import { ActiveCallScreen, resetCallFloatPositions } from './ActiveCallScreen.js';
import { IncomingCallScreen } from './IncomingCallScreen.js';
import { mergeTheme } from './theme.js';
import type { CallingUIProps } from './ui-types.js';
import { useAndroidPipArming } from '../native/PictureInPicture.js';
import { getPeerAvatarUrl, getPeerInitials, isRemoteVideoEnabled } from './peerDisplay.js';

const TERMINAL = new Set(['ended', 'failed', 'rejected', 'missed', 'busy']);
const IN_CALL = new Set(['accepted', 'connecting', 'connected', 'reconnecting']);

/**
 * RN Modal on iOS is a separate window — it does not inherit the app's
 * SafeAreaProvider, so useSafeAreaInsets() returns 0 and chrome sits under
 * the notch/Dynamic Island. Nest a provider only on iOS (Android layout is fine).
 */
function IosModalSafeArea({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'ios') {
    return children as React.JSX.Element;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SafeAreaProvider } = require('react-native-safe-area-context') as {
      SafeAreaProvider: React.ComponentType<{ children?: React.ReactNode }>;
    };
    return <SafeAreaProvider>{children}</SafeAreaProvider>;
  } catch {
    return children as React.JSX.Element;
  }
}

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
 * Normal call: RN Modal (proven flex layout on iOS + Android).
 * Native PiP: hide the Modal so the app is usable; call state stays in CallManager.
 *
 * Android background Accept: IncomingCallActivity → MainActivity often leaves the
 * first Modal Dialog blank. Remount Modal on foreground / wake-accept (key bump).
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
  /**
   * Native system PiP is showing. Call state is unchanged.
   * Android: hide the calling Modal so Home PiP shows the native overlay
   * (Modal-on-top caused a black Home PiP) and Minimize leaves the app usable.
   */
  const [pipActive, setPipActive] = useState(false);
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
        setPipActive(false);
        resetCallFloatPositions();
        return;
      }
      if (
        IN_CALL.has(active.state) ||
        client.isWakingForCall() ||
        client.isAutoAcceptingCall(active.callId)
      ) {
        suppressIncoming(active.callId);
      }
      setCall(active);
      setIncoming(shouldShowIncomingCall(active, client, suppressedRef.current) ? active : null);
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
          setPipActive(false);
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
        setPipActive(false);
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
    const pipMod = NativeModules.AlaznahCallingPip;
    if (!pipMod) return undefined;
    const emitter = new NativeEventEmitter(pipMod);
    const sub = emitter.addListener(
      'AlaznahCallingPipModeChanged',
      (payload: { active?: boolean; error?: string }) => {
        if (payload?.error) {
          setPipActive(false);
          return;
        }
        setPipActive(Boolean(payload?.active));
      },
    );
    return () => sub.remove();
  }, []);

  // Wake Accept / native auto-accept: never keep the inbound ringing gate that
  // hides ActiveCall (background Accept used to flash a blank host screen).
  const wakeAccepting =
    !!call && (client.isWakingForCall() || client.isAutoAcceptingCall(call.callId));

  // Do NOT remount Modal during/after background Accept.
  // Key remount destroyed the Android Dialog under live Camera/WebRTC and left
  // calls stuck on Connecting. Proven Modal + flex:1 layout is enough.

  const showIncoming =
    !!incoming &&
    incoming.state === 'ringing' &&
    suppressedIncomingId !== incoming.callId &&
    AppState.currentState !== 'background' &&
    !client.isAutoAcceptingCall(incoming.callId) &&
    !wakeAccepting &&
    !(call && call.callId === incoming.callId && IN_CALL.has(call.state));

  const showActive =
    !!call &&
    !TERMINAL.has(call.state) &&
    (wakeAccepting ||
      !(call.direction === 'inbound' && call.state === 'ringing' && !suppressedIncomingId)) &&
    !(showIncoming && call.callId === incoming?.callId);

  const showActiveLocked =
    showActive ||
    (!!call &&
      !TERMINAL.has(call.state) &&
      suppressedIncomingId === call.callId &&
      !showIncoming) ||
    wakeAccepting;

  useEffect(() => {
    if (!showActiveLocked) {
      setPipActive(false);
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
  const iosPipPresentationEligible =
    Platform.OS === 'ios' &&
    !!call &&
    call.mediaType === 'video' &&
    !TERMINAL.has(call.state) &&
    showActiveLocked &&
    !showIncoming;
  const androidPipStreamUrl =
    (call?.remoteStream && typeof call.remoteStream.toURL === 'function'
      ? call.remoteStream.toURL()
      : undefined) ??
    (call?.videoEnabled && call.localStream && typeof call.localStream.toURL === 'function'
      ? call.localStream.toURL()
      : undefined);
  useAndroidPipArming(
    androidPipEligible || iosPipPresentationEligible,
    androidPipStreamUrl,
    call
      ? {
          remoteVideoActive: isRemoteVideoEnabled(call),
          initials: getPeerInitials(call),
          avatarUrl: getPeerAvatarUrl(call),
          surfaceColor: theme.colors.surface,
          accentColor: theme.colors.accent,
        }
      : undefined,
  );

  const enterSystemPip = useCallback(() => {
    const native = NativeModules.AlaznahCallingPip as
      | {
          enter?: () => Promise<boolean>;
          setRemoteVideoActive?: (
            active: boolean,
            initials: string,
            avatarUrl: string,
            surfaceColor: string,
            accentColor: string,
          ) => Promise<boolean>;
        }
      | undefined;
    if (Platform.OS === 'ios') {
      if (!native?.enter) return;
      void native.enter().then(() => undefined);
      return;
    }
    if (!native?.enter) return;
    if (call && native.setRemoteVideoActive) {
      void native
        .setRemoteVideoActive(
          isRemoteVideoEnabled(call),
          getPeerInitials(call),
          getPeerAvatarUrl(call) ?? '',
          theme.colors.surface,
          theme.colors.accent,
        )
        .catch(() => undefined);
    }
    void native.enter().then((ok) => {
      if (ok) setPipActive(true);
    });
  }, [call, theme.colors.accent, theme.colors.surface]);

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
          onMinimize={enterSystemPip}
          androidSystemPipActive={Platform.OS === 'android' && pipActive}
        />
      )
    ) : null;

  const incomingBody =
    showIncoming && incoming ? (
      renderIncomingScreen ? (
        renderIncomingScreen({
          call: incoming,
          onAccept: () =>
            beginAccept(incoming.callId, () => {
              void client.accept(incoming.callId).catch((e) => onError?.(e));
            }),
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
    ) : null;

  const modalBody = showIncoming
    ? incomingBody
    : Platform.OS === 'android' && pipActive
      ? null
      : activeBody;
  const showCallModal = Boolean(modalBody);

  return (
    <View
      style={[
        styles.host,
        pipActive && Platform.OS === 'android' ? styles.hostPassThrough : null,
        style,
      ]}
      pointerEvents="box-none"
    >
      {modalBody ? (
        <Modal
          animationType="none"
          visible={showCallModal}
          hardwareAccelerated
          transparent={false}
          presentationStyle="overFullScreen"
          statusBarTranslucent
        >
          <IosModalSafeArea>
            <View style={styles.modalRoot}>
              <StatusBar barStyle="light-content" backgroundColor="#000000" translucent />
              <View style={styles.modalBody}>{modalBody as React.JSX.Element}</View>
            </View>
          </IosModalSafeArea>
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
  hostPassThrough: {
    width: 0,
    height: 0,
    overflow: 'hidden',
    zIndex: 0,
    elevation: 0,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  modalBody: {
    flex: 1,
  },
});
