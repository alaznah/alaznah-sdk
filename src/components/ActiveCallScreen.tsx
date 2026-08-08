import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  ImageBackground,
  PanResponder,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { LocalVideoView, RemoteVideoView } from './VideoView.js';
import type { ActiveCall, CallingClient, MediaStreamLike } from '../types/index.js';
import { CallControls } from './CallControls.js';
import {
  FlashIcon,
  FlashOffIcon,
  FlipCameraIcon,
  MicOffIcon,
  MinimizeIcon,
} from './icons.js';
import type { CallingTheme } from './theme.js';
import type { CallingUISlots } from './ui-types.js';
import { useCallPictureInPicture } from '../native/PictureInPicture.js';

type SafeInsets = { top: number; bottom: number; left: number; right: number };

const FLOAT_W = 112;
const FLOAT_H = 168;
const MINI_W = 118;
const MINI_H = 178;
const CHROME_AUTO_HIDE_MS = 4500;
const ROUND_BTN = 34;

function useSafeInsets(): SafeInsets {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useSafeAreaInsets } = require('react-native-safe-area-context') as {
      useSafeAreaInsets: () => SafeInsets;
    };
    return useSafeAreaInsets();
  } catch {
    return {
      top: Platform.OS === 'ios' ? 47 : 24,
      bottom: Platform.OS === 'ios' ? 34 : 0,
      left: 0,
      right: 0,
    };
  }
}

function formatCallDuration(startedAt: number | null | undefined): string {
  if (startedAt == null) return '00:00';
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function snapFloatXToEdge(x: number, minX: number, maxX: number): number {
  const screenMid = Dimensions.get('window').width / 2;
  const tileCenter = x + FLOAT_W / 2;
  return tileCenter < screenMid ? minX : maxX;
}

function runSafe(
  action: () => Promise<unknown> | void,
  onError?: (error: Error) => void,
): void {
  try {
    const result = action();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((err) => {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

type Props = {
  call: ActiveCall;
  client: CallingClient;
  theme: CallingTheme;
  backgroundColor?: string;
  backgroundImage?: ImageSourcePropType;
  slots?: CallingUISlots;
  onEnd: () => void;
  onError?: (error: Error) => void;
  /** Collapse full-screen call into an in-app floating bubble. */
  onMinimize?: () => void;
};

function statusLabel(call: ActiveCall): string {
  if (call.state === 'connected') return 'Connected';
  if (call.state === 'reconnecting') return 'Reconnecting…';
  if (call.state === 'accepted' || call.direction === 'inbound' || call.state === 'connecting') {
    return 'Connecting…';
  }
  if (call.state === 'ringing') return 'Ringing…';
  return 'Calling…';
}

const IOS_PIP_BASE = {
  enabled: true,
  startAutomatically: true,
  stopAutomatically: true,
  preferredSize: { width: 9, height: 16 },
} as const;

function RoundIconButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress?: () => void;
  children: React.JSX.Element;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.roundBtn, { opacity: pressed ? 0.8 : 1 }]}
    >
      {children}
    </Pressable>
  );
}

function LocalCameraOverlayButtons({
  call,
  client,
  onError,
  visible,
}: {
  call: ActiveCall;
  client: CallingClient;
  onError?: (error: Error) => void;
  visible: boolean;
}) {
  if (!visible || !call.videoEnabled) return null;
  return (
    <View style={styles.localCamBtns} pointerEvents="box-none">
      <RoundIconButton
        label="Flip camera"
        onPress={() => runSafe(() => client.switchCamera(call.callId), onError)}
      >
        <FlipCameraIcon size={17} color="#fff" />
      </RoundIconButton>
      <RoundIconButton
        label={call.torchOn ? 'Turn flash off' : 'Turn flash on'}
        onPress={() => runSafe(() => client.setTorch(!call.torchOn, call.callId), onError)}
      >
        {call.torchOn ? (
          <FlashIcon size={17} color="#fff" />
        ) : (
          <FlashOffIcon size={17} color="#fff" />
        )}
      </RoundIconButton>
    </View>
  );
}

function FloatingPipTile({
  insets,
  mutedBadge,
  chromeVisible,
  onTap,
  overlay,
  children,
}: {
  insets: SafeInsets;
  mutedBadge?: boolean;
  chromeVisible: boolean;
  onTap: () => void;
  overlay?: React.JSX.Element | null;
  children: React.JSX.Element;
}) {
  const screen = Dimensions.get('window');
  const bottomReserve = chromeVisible ? 110 : 16;
  const boundsRef = useRef({
    minX: 8 + insets.left,
    minY: insets.top + 8,
    maxX: Math.max(8 + insets.left, screen.width - FLOAT_W - 8 - insets.right),
    maxY: Math.max(
      insets.top + 8,
      screen.height - FLOAT_H - 8 - insets.bottom - bottomReserve,
    ),
  });
  boundsRef.current = {
    minX: 8 + insets.left,
    minY: insets.top + 8,
    maxX: Math.max(8 + insets.left, screen.width - FLOAT_W - 8 - insets.right),
    maxY: Math.max(
      insets.top + 8,
      screen.height - FLOAT_H - 8 - insets.bottom - bottomReserve,
    ),
  };

  const pan = useRef(
    new Animated.ValueXY({
      x: boundsRef.current.maxX,
      y: boundsRef.current.minY + 52,
    }),
  ).current;
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  useEffect(() => {
    const { minX, minY, maxX, maxY } = boundsRef.current;
    pan.stopAnimation((value) => {
      const x = snapFloatXToEdge(clamp(value.x, minX, maxX), minX, maxX);
      const y = clamp(value.y, minY, maxY);
      pan.setValue({ x, y });
    });
  }, [insets.top, insets.bottom, insets.left, insets.right, chromeVisible, pan]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        movedRef.current = false;
        pan.stopAnimation((value) => {
          startRef.current = { x: value.x, y: value.y };
          pan.setOffset(value);
          pan.setValue({ x: 0, y: 0 });
        });
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) {
          movedRef.current = true;
        }
        const { minX, minY, maxX, maxY } = boundsRef.current;
        const absX = clamp(startRef.current.x + g.dx, minX, maxX);
        const absY = clamp(startRef.current.y + g.dy, minY, maxY);
        pan.setValue({
          x: absX - startRef.current.x,
          y: absY - startRef.current.y,
        });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        pan.stopAnimation((value) => {
          const { minX, minY, maxX, maxY } = boundsRef.current;
          const nextY = clamp(value.y, minY, maxY);
          const nextX = snapFloatXToEdge(clamp(value.x, minX, maxX), minX, maxX);
          startRef.current = { x: nextX, y: nextY };
          Animated.spring(pan, {
            toValue: { x: nextX, y: nextY },
            useNativeDriver: false,
            bounciness: 0,
            speed: 22,
          }).start();
        });
        if (!movedRef.current) {
          onTapRef.current();
        }
      },
      onPanResponderTerminate: () => {
        pan.flattenOffset();
      },
    }),
  ).current;

  return (
    <Animated.View
      collapsable={false}
      pointerEvents="box-none"
      style={[
        styles.floatTile,
        {
          transform: [{ translateX: pan.x }, { translateY: pan.y }],
        },
      ]}
    >
      <View collapsable={false} style={styles.fillVideo} {...responder.panHandlers}>
        {children}
      </View>
      {mutedBadge ? (
        <View style={styles.localMuteBadge} pointerEvents="none">
          <MicOffIcon size={16} color="#fff" />
        </View>
      ) : null}
      {overlay}
    </Animated.View>
  );
}

export function ActiveCallScreen({
  call,
  client,
  theme,
  backgroundColor,
  backgroundImage,
  slots,
  onEnd,
  onError,
  onMinimize,
}: Props) {
  const insets = useSafeInsets();
  const isVideo = call.mediaType === 'video';
  const [localIsPrimary, setLocalIsPrimary] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [elapsedLabel, setElapsedLabel] = useState(() => formatCallDuration(call.startedAt));
  const remoteVideoRef = useRef<unknown>(null);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callActive =
    isVideo && !['ended', 'failed', 'rejected', 'missed', 'busy'].includes(call.state);
  const pip = useCallPictureInPicture({
    enabled: callActive,
    iosRemoteVideoRef: remoteVideoRef,
  });

  const localStreamUrl =
    call.videoEnabled && call.localStream && typeof call.localStream.toURL === 'function'
      ? call.localStream.toURL()
      : undefined;

  const iosPipOptions = useMemo(
    () =>
      Platform.OS === 'ios'
        ? { ...IOS_PIP_BASE, ...(localStreamUrl ? { localStreamURL: localStreamUrl } : {}) }
        : undefined,
    [localStreamUrl],
  );

  const clearChromeTimer = useCallback(() => {
    if (chromeHideTimer.current) {
      clearTimeout(chromeHideTimer.current);
      chromeHideTimer.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback(() => {
    clearChromeTimer();
    if (!isVideo) return;
    chromeHideTimer.current = setTimeout(() => {
      setChromeVisible(false);
    }, CHROME_AUTO_HIDE_MS);
  }, [clearChromeTimer, isVideo]);

  useEffect(() => {
    Animated.timing(chromeOpacity, {
      toValue: chromeVisible ? 1 : 0,
      duration: chromeVisible ? 180 : 220,
      useNativeDriver: true,
    }).start();
    if (chromeVisible) {
      scheduleChromeHide();
    } else {
      clearChromeTimer();
    }
    return clearChromeTimer;
  }, [chromeVisible, chromeOpacity, scheduleChromeHide, clearChromeTimer]);

  useEffect(() => {
    if (call.state !== 'connected' || call.startedAt == null) {
      setElapsedLabel(statusLabel(call));
      return undefined;
    }
    setElapsedLabel(formatCallDuration(call.startedAt));
    const timer = setInterval(() => {
      setElapsedLabel(formatCallDuration(call.startedAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [call, call.startedAt, call.state]);

  const swapVideos = useCallback(() => {
    setLocalIsPrimary((prev) => !prev);
  }, []);

  const toggleChrome = useCallback(() => {
    setChromeVisible((prev) => !prev);
  }, []);

  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    scheduleChromeHide();
  }, [scheduleChromeHide]);

  const enterPip = useCallback(() => {
    if (Platform.OS === 'android') {
      // System Activity PiP must keep ActiveCallScreen mounted (hideChrome).
      // MinimizedCallBubble inside the PiP window is wrong vs iOS video PiP.
      void pip.enter().catch(() => undefined);
      return;
    }
    // iOS: in-app bubble + AVKit iosPIP on RemoteVideoView.
    void pip.enter().catch(() => undefined);
    onMinimize?.();
  }, [pip, onMinimize]);

  if (isVideo) {
    const localStream = call.videoEnabled ? call.localStream : null;
    const remoteStream = call.remoteStream;
    const remoteIsPrimary = !localIsPrimary;
    const localIsShown = Boolean(localStream);
    const remoteIsShown = Boolean(remoteStream);
    const hideChrome = pip.isInPictureInPicture && Platform.OS === 'android';
    const showFloat = remoteIsShown && localIsShown && !hideChrome;
    /** Outgoing / pre-connect: full-bleed local like WhatsApp ringing UI. */
    const fullLocalPhase = localIsShown && !remoteIsShown;

    const topRightStack = fullLocalPhase ? (
      <View style={styles.topRightStack}>
        {call.videoEnabled ? (
          <RoundIconButton
            label="Flip camera"
            onPress={() => {
              bumpChrome();
              runSafe(() => client.switchCamera(call.callId), onError);
            }}
          >
            <FlipCameraIcon size={18} color="#fff" />
          </RoundIconButton>
        ) : null}
        {call.videoEnabled ? (
          <RoundIconButton
            label={call.torchOn ? 'Turn flash off' : 'Turn flash on'}
            onPress={() => {
              bumpChrome();
              runSafe(() => client.setTorch(!call.torchOn, call.callId), onError);
            }}
          >
            {call.torchOn ? (
              <FlashIcon size={18} color="#fff" />
            ) : (
              <FlashOffIcon size={18} color="#fff" />
            )}
          </RoundIconButton>
        ) : null}
      </View>
    ) : null;

    return (
      <View style={styles.fill}>
        <StatusBar barStyle="light-content" backgroundColor="#000000" translucent />

        <View style={styles.videoLayer} pointerEvents="box-none">
          {!remoteIsShown && !localIsShown ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}

          {remoteIsShown && remoteIsPrimary ? (
            <View pointerEvents="none" collapsable={false} style={styles.fullVideo}>
              <RemoteVideoView
                ref={remoteVideoRef}
                stream={remoteStream as MediaStreamLike}
                objectFit="cover"
                style={styles.fillVideo}
                zOrder={0}
                iosPIP={Platform.OS === 'ios' ? iosPipOptions : undefined}
              />
            </View>
          ) : null}

          {(fullLocalPhase || (localIsShown && localIsPrimary)) && localStream ? (
            <View pointerEvents="none" style={styles.fullVideo}>
              <LocalVideoView
                stream={localStream as MediaStreamLike}
                mirror={call.facingMode !== 'environment'}
                objectFit="cover"
                style={styles.fillVideo}
                zOrder={0}
              />
            </View>
          ) : null}

          {!remoteIsShown && remoteIsPrimary && !localIsShown ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle call controls"
            onPress={toggleChrome}
            style={styles.chromeToggleHit}
          />

          {showFloat && remoteIsPrimary ? (
            <FloatingPipTile
              insets={insets}
              mutedBadge={call.muted}
              chromeVisible={chromeVisible && !hideChrome}
              onTap={() => {
                bumpChrome();
                swapVideos();
              }}
              overlay={
                <LocalCameraOverlayButtons
                  call={call}
                  client={client}
                  onError={onError}
                  visible={chromeVisible && !hideChrome}
                />
              }
            >
              <LocalVideoView
                stream={localStream as MediaStreamLike}
                mirror={call.facingMode !== 'environment'}
                objectFit="cover"
                style={styles.fillVideo}
                zOrder={1}
              />
            </FloatingPipTile>
          ) : null}

          {showFloat && !remoteIsPrimary ? (
            <FloatingPipTile
              insets={insets}
              chromeVisible={chromeVisible && !hideChrome}
              onTap={() => {
                bumpChrome();
                swapVideos();
              }}
            >
              <RemoteVideoView
                ref={remoteVideoRef}
                stream={remoteStream as MediaStreamLike}
                objectFit="cover"
                style={styles.fillVideo}
                zOrder={1}
                iosPIP={Platform.OS === 'ios' ? iosPipOptions : undefined}
              />
            </FloatingPipTile>
          ) : null}
        </View>

        {!hideChrome ? (
          <>
            <Animated.View
              pointerEvents={chromeVisible ? 'box-none' : 'none'}
              style={[
                styles.topChromeAbs,
                {
                  paddingTop: insets.top + 6,
                  opacity: chromeOpacity,
                },
              ]}
            >
              <RoundIconButton label="Enter picture in picture" onPress={enterPip}>
                <MinimizeIcon size={18} color="#fff" />
              </RoundIconButton>

              <View style={styles.videoHeader} pointerEvents="none">
                {(slots?.renderHeader?.(call) ?? (
                  <Text style={styles.videoName}>{call.peerId}</Text>
                )) as React.JSX.Element}
                {(slots?.renderStatus?.(call) ?? (
                  <Text style={styles.videoStatus}>
                    {call.state === 'connected' ? elapsedLabel : statusLabel(call)}
                  </Text>
                )) as React.JSX.Element}
              </View>

              {topRightStack ?? <View style={styles.topRightSpacer} />}
            </Animated.View>

            {call.muted ? (
              <View pointerEvents="none" style={[styles.muteBanner, { top: insets.top + 56 }]}>
                <MicOffIcon size={14} color="#fff" />
                <Text style={styles.muteToastText}>You are muted</Text>
              </View>
            ) : null}

            <Animated.View
              pointerEvents={chromeVisible ? 'box-none' : 'none'}
              onTouchStart={bumpChrome}
              style={[
                styles.controlsDockAbs,
                {
                  paddingBottom: insets.bottom + 12,
                  opacity: chromeOpacity,
                  transform: [
                    {
                      translateY: chromeOpacity.interpolate({
                        inputRange: [0, 1],
                        outputRange: [24, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              {(slots?.renderControls?.(call) ?? (
                <CallControls
                  call={call}
                  client={client}
                  theme={theme}
                  onEnd={onEnd}
                  onError={onError}
                />
              )) as React.JSX.Element}
            </Animated.View>
            {(slots?.renderOverlay?.(call) ?? null) as React.JSX.Element | null}
          </>
        ) : null}
      </View>
    );
  }

  const audioContent = (
    <View style={[styles.audioContainer, { paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.audioStage}>
        {(slots?.renderAvatar?.(call) ?? (
          <View
            style={[
              styles.avatar,
              {
                backgroundColor: theme.colors.surface,
                width: theme.radii.avatar * 2,
                height: theme.radii.avatar * 2,
                borderRadius: theme.radii.avatar,
              },
            ]}
          >
            <Text style={[styles.avatarText, { color: theme.colors.text }]}>
              {call.peerId.slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )) as React.JSX.Element}
        {(slots?.renderHeader?.(call) ?? (
          <Text style={[styles.name, { color: theme.colors.text }]}>{call.peerId}</Text>
        )) as React.JSX.Element}
        {(slots?.renderStatus?.(call) ?? (
          <Text style={{ color: theme.colors.textMuted }}>{statusLabel(call)}</Text>
        )) as React.JSX.Element}
      </View>

      <View style={styles.controlsDock}>
        {(slots?.renderControls?.(call) ?? (
          <CallControls
            call={call}
            client={client}
            theme={theme}
            onEnd={onEnd}
            onError={onError}
          />
        )) as React.JSX.Element}
      </View>
      {(slots?.renderOverlay?.(call) ?? null) as React.JSX.Element | null}
    </View>
  );

  if (backgroundImage) {
    return (
      <ImageBackground source={backgroundImage} style={styles.fill} resizeMode="cover">
        {audioContent}
      </ImageBackground>
    );
  }

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: backgroundColor ?? theme.colors.background },
      ]}
    >
      {audioContent}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  videoLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  fullVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  fillVideo: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatTile: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: FLOAT_W,
    height: FLOAT_H,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 12,
    elevation: 12,
    backgroundColor: '#111',
  },
  chromeToggleHit: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  localMuteBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  localCamBtns: {
    position: 'absolute',
    top: 8,
    right: 8,
    gap: 8,
    zIndex: 2,
  },
  roundBtn: {
    width: ROUND_BTN,
    height: ROUND_BTN,
    borderRadius: ROUND_BTN / 2,
    backgroundColor: 'rgba(50,50,50,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topChromeAbs: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    elevation: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
  },
  topRightStack: {
    gap: 10,
    alignItems: 'center',
  },
  topRightSpacer: {
    width: ROUND_BTN,
  },
  videoHeader: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  videoName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  videoStatus: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  muteBanner: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 30,
    elevation: 30,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(20,20,20,0.82)',
  },
  muteToastText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
  },
  controlsDockAbs: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    elevation: 20,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  controlsDock: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    width: '100%',
  },
  audioContainer: {
    flex: 1,
    justifyContent: 'space-between',
  },
  audioStage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  avatarText: { fontSize: 42, fontWeight: '700' },
  name: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  miniBubble: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: MINI_W,
    height: MINI_H,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: '#111',
    zIndex: 100,
    elevation: 24,
  },
  miniPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
  },
  miniPlaceholderText: {
    color: '#fff',
    fontSize: 36,
    fontWeight: '700',
  },
  miniFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  miniName: {
    flex: 1,
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  miniEnd: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#e83829',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniEndText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
});

/**
 * In-app floating call bubble shown after minimize — tap to restore full screen.
 */
export function MinimizedCallBubble({
  call,
  onExpand,
  onEnd,
}: {
  call: ActiveCall;
  onExpand: () => void;
  onEnd: () => void;
}) {
  const insets = useSafeInsets();
  const screen = Dimensions.get('window');
  const remote = call.remoteStream;
  const local = call.videoEnabled ? call.localStream : null;
  const stream = (remote ?? local) as MediaStreamLike | null | undefined;
  const isLocalFallback = !remote && Boolean(local);

  const pan = useRef(
    new Animated.ValueXY({
      x: screen.width - MINI_W - 12 - insets.right,
      y: insets.top + 56,
    }),
  ).current;
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderGrant: () => {
        movedRef.current = false;
        pan.stopAnimation((value) => {
          startRef.current = { x: value.x, y: value.y };
          pan.setOffset(value);
          pan.setValue({ x: 0, y: 0 });
        });
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) movedRef.current = true;
        const minX = 8 + insets.left;
        const minY = insets.top + 8;
        const maxX = Math.max(minX, screen.width - MINI_W - 8 - insets.right);
        const maxY = Math.max(minY, screen.height - MINI_H - 8 - insets.bottom);
        const absX = clamp(startRef.current.x + g.dx, minX, maxX);
        const absY = clamp(startRef.current.y + g.dy, minY, maxY);
        pan.setValue({
          x: absX - startRef.current.x,
          y: absY - startRef.current.y,
        });
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        pan.stopAnimation((value) => {
          const minX = 8 + insets.left;
          const minY = insets.top + 8;
          const maxX = Math.max(minX, screen.width - MINI_W - 8 - insets.right);
          const maxY = Math.max(minY, screen.height - MINI_H - 8 - insets.bottom);
          const nextX = snapFloatXToEdge(clamp(value.x, minX, maxX), minX, maxX);
          const nextY = clamp(value.y, minY, maxY);
          Animated.spring(pan, {
            toValue: { x: nextX, y: nextY },
            useNativeDriver: false,
            bounciness: 0,
            speed: 22,
          }).start();
        });
        if (!movedRef.current) onExpand();
      },
      onPanResponderTerminate: () => pan.flattenOffset(),
    }),
  ).current;

  return (
    <Animated.View
      collapsable={false}
      style={[
        styles.miniBubble,
        {
          transform: [{ translateX: pan.x }, { translateY: pan.y }],
        },
      ]}
      {...responder.panHandlers}
    >
      {stream ? (
        isLocalFallback ? (
          <LocalVideoView
            stream={stream}
            mirror={call.facingMode !== 'environment'}
            objectFit="cover"
            style={styles.fillVideo}
            zOrder={2}
          />
        ) : (
          <RemoteVideoView stream={stream} objectFit="cover" style={styles.fillVideo} zOrder={2} />
        )
      ) : (
        <View style={styles.miniPlaceholder}>
          <Text style={styles.miniPlaceholderText}>{call.peerId.slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.miniFooter} pointerEvents="box-none">
        <Text numberOfLines={1} style={styles.miniName}>
          {call.peerId}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End call"
          hitSlop={8}
          onPress={onEnd}
          style={styles.miniEnd}
        >
          <Text style={styles.miniEndText}>✕</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
