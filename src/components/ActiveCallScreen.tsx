import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  ImageBackground,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { LocalVideoView, RemoteVideoView } from './VideoView.js';
import type { ActiveCall, CallingClient, MediaStreamLike } from '../types/index.js';
import { CallControls } from './CallControls.js';
import { FlashIcon, FlashOffIcon, FlipCameraIcon, MicOffIcon, MinimizeIcon } from './icons.js';
import type { CallingTheme } from './theme.js';
import type { CallingUISlots } from './ui-types.js';
import { useCallPictureInPicture } from '../native/PictureInPicture.js';
import { getPeerDisplayName, getPeerInitials, isRemoteMuted } from './peerDisplay.js';

type SafeInsets = { top: number; bottom: number; left: number; right: number };

const FLOAT_COMPACT_W = 112;
const FLOAT_COMPACT_H = 168;
/** Slightly larger while call controls are visible. */
const FLOAT_EXPANDED_W = 160;
const FLOAT_EXPANDED_H = 240;
const MINI_W = 118;
const MINI_H = 178;
const CHROME_AUTO_HIDE_MS = 4500;
const ROUND_BTN = 34;
const FLOAT_SIZE_MS = 280;

function floatTileSize(chromeVisible: boolean): { w: number; h: number } {
  return chromeVisible
    ? { w: FLOAT_EXPANDED_W, h: FLOAT_EXPANDED_H }
    : { w: FLOAT_COMPACT_W, h: FLOAT_COMPACT_H };
}

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

/** Fit `aw:ah` inside `cw×ch` (CSS object-fit: contain size). */
function snapFloatXToEdge(x: number, minX: number, maxX: number, tileW: number): number {
  const screenMid = Dimensions.get('screen').width / 2;
  const tileCenter = x + tileW / 2;
  return tileCenter < screenMid ? minX : maxX;
}

/** Snap floating local tile to nearest corner (TL / TR / BL / BR). */
function snapFloatToCorner(
  x: number,
  y: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tileW: number,
  tileH: number,
): { x: number; y: number } {
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const cx = x + tileW / 2;
  const cy = y + tileH / 2;
  return {
    x: cx < midX ? minX : maxX,
    y: cy < midY ? minY : maxY,
  };
}

/** Survives ACS remount after Android PiP exit so the float does not jump to TL. */
let persistedFloatPos: { x: number; y: number } | null = null;
/** Survives bubble remount across minimize/expand. */
let persistedMiniBubblePos: { x: number; y: number } | null = null;

/** Call when a call ends so the next call starts at default top-right. */
export function resetCallFloatPositions(): void {
  persistedFloatPos = null;
  persistedMiniBubblePos = null;
}

function defaultFloatTopRight(insets: SafeInsets, tileW: number): { x: number; y: number } {
  const screen = Dimensions.get('screen');
  const maxX = Math.max(8 + insets.left, screen.width - tileW - 8 - insets.right);
  const minY = insets.top + 8;
  return { x: maxX, y: minY + 52 };
}

function floatBounds(insets: SafeInsets, chromeVisible: boolean, tileW: number, tileH: number) {
  // Use screen (not window) — in Android PiP `window` shrinks and maxX≈minX → top-left trap.
  const screen = Dimensions.get('screen');
  const bottomReserve = chromeVisible ? 110 : 16;
  return {
    minX: 8 + insets.left,
    minY: insets.top + 8,
    maxX: Math.max(8 + insets.left, screen.width - tileW - 8 - insets.right),
    maxY: Math.max(insets.top + 8, screen.height - tileH - 8 - insets.bottom - bottomReserve),
  };
}

function runSafe(action: () => Promise<unknown> | void, onError?: (error: Error) => void): void {
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
  /**
   * Android: CallingUI owns Activity PiP presentation. Pass true while ACS is
   * hosted for system PiP — local pip hook state resets on Modal↔host remount.
   */
  androidSystemPipActive?: boolean;
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
  // AVKit preferredContentSize aspect (matches known-good iOS PiP).
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
  // Animate layout W/H + dock pan. Keep RTCView mounted (no video blink).
  const { w: tileW, h: tileH } = floatTileSize(chromeVisible);
  const tileSizeRef = useRef({ w: tileW, h: tileH });
  tileSizeRef.current = { w: tileW, h: tileH };

  const boundsRef = useRef(floatBounds(insets, chromeVisible, tileW, tileH));
  boundsRef.current = floatBounds(insets, chromeVisible, tileW, tileH);

  const widthAnim = useRef(new Animated.Value(tileW)).current;
  const heightAnim = useRef(new Animated.Value(tileH)).current;

  const pan = useRef(
    new Animated.ValueXY(
      (() => {
        const b = boundsRef.current;
        const saved = persistedFloatPos;
        if (
          saved &&
          saved.x >= b.minX - 1 &&
          saved.x <= b.maxX + 1 &&
          saved.y >= b.minY - 1 &&
          saved.y <= b.maxY + 1
        ) {
          return saved;
        }
        return defaultFloatTopRight(insets, tileW);
      })(),
    ),
  ).current;
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  useEffect(() => {
    const { w, h } = tileSizeRef.current;
    const { minX, minY, maxX, maxY } = boundsRef.current;
    const ease = Easing.bezier(0.22, 1, 0.36, 1);

    pan.stopAnimation((value) => {
      const onRight = Math.abs(value.x - maxX) <= Math.abs(value.x - minX);
      const onBottom = Math.abs(value.y - maxY) <= Math.abs(value.y - minY);
      let nextX = clamp(value.x, minX, maxX);
      let nextY = clamp(value.y, minY, maxY);
      if (onRight) nextX = maxX;
      if (onBottom) nextY = maxY;
      const nearCorner =
        (nextX <= minX + 2 || nextX >= maxX - 2) && (nextY <= minY + 2 || nextY >= maxY - 2);
      const placed = nearCorner
        ? snapFloatToCorner(nextX, nextY, minX, minY, maxX, maxY, w, h)
        : { x: nextX, y: nextY };
      persistedFloatPos = placed;

      Animated.parallel([
        Animated.timing(widthAnim, {
          toValue: w,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
        Animated.timing(heightAnim, {
          toValue: h,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
        Animated.timing(pan.x, {
          toValue: placed.x,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
        Animated.timing(pan.y, {
          toValue: placed.y,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
      ]).start();
    });
  }, [
    insets.top,
    insets.bottom,
    insets.left,
    insets.right,
    chromeVisible,
    pan,
    widthAnim,
    heightAnim,
  ]);

  useEffect(
    () => () => {
      pan.stopAnimation((value) => {
        persistedFloatPos = { x: value.x, y: value.y };
      });
    },
    [pan],
  );

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
          const { w, h } = tileSizeRef.current;
          const { minX, minY, maxX, maxY } = boundsRef.current;
          const next = snapFloatToCorner(
            clamp(value.x, minX, maxX),
            clamp(value.y, minY, maxY),
            minX,
            minY,
            maxX,
            maxY,
            w,
            h,
          );
          startRef.current = next;
          persistedFloatPos = next;
          Animated.spring(pan, {
            toValue: next,
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
          width: widthAnim,
          height: heightAnim,
          transform: [{ translateX: pan.x }, { translateY: pan.y }],
        },
      ]}
    >
      {/*
        Pan/drag + tap-to-swap only on the video surface — not overlay buttons
        (flip/torch), which otherwise lose to PanResponder and swap local/remote.
      */}
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
  androidSystemPipActive = false,
}: Props) {
  const insets = useSafeInsets();
  const isVideo = call.mediaType === 'video';
  const [chromeVisible, setChromeVisible] = useState(true);
  /** When true, local camera is full-screen and remote floats (tap the small tile to swap). */
  const [localIsPrimary, setLocalIsPrimary] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState(() => formatCallDuration(call.startedAt));
  /** Android SurfaceView often stays black until remount after tracks attach. */
  const [androidVideoEpoch, setAndroidVideoEpoch] = useState(0);
  /** Remount remote SurfaceView when PiP window size is known (not on early signal). */
  const [androidPipSurfaceEpoch, setAndroidPipSurfaceEpoch] = useState(0);
  const androidPipLayoutKeyRef = useRef('');
  const remoteVideoRef = useRef<unknown>(null);
  const androidRemoteLayoutRef = useRef<View>(null);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callActive =
    isVideo && !['ended', 'failed', 'rejected', 'missed', 'busy'].includes(call.state);

  useEffect(() => {
    if (['ended', 'failed', 'rejected', 'missed', 'busy'].includes(call.state)) {
      resetCallFloatPositions();
    }
  }, [call.state]);

  /** Android: connected video + a live surface. iOS keeps prior callActive arming. */
  const androidPipEligible =
    callActive &&
    (call.state === 'connected' || call.state === 'reconnecting') &&
    Boolean(call.remoteStream || (call.videoEnabled && call.localStream));
  const pip = useCallPictureInPicture({
    enabled: Platform.OS === 'ios' ? callActive : androidPipEligible,
    iosRemoteVideoRef: remoteVideoRef,
    androidVideoLayoutRef: androidRemoteLayoutRef,
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

  /** Outgoing / pre-remote: always show controls (tap must not hide them). */
  const chromeLocked = isVideo && !call.remoteStream;

  const scheduleChromeHide = useCallback(() => {
    clearChromeTimer();
    if (!isVideo || chromeLocked) return;
    chromeHideTimer.current = setTimeout(() => {
      setChromeVisible(false);
    }, CHROME_AUTO_HIDE_MS);
  }, [clearChromeTimer, isVideo, chromeLocked]);

  useEffect(() => {
    if (chromeLocked) {
      setChromeVisible(true);
      clearChromeTimer();
    }
  }, [chromeLocked, clearChromeTimer]);

  useEffect(() => {
    Animated.timing(chromeOpacity, {
      toValue: chromeVisible || chromeLocked ? 1 : 0,
      duration: chromeVisible || chromeLocked ? 180 : 220,
      useNativeDriver: true,
    }).start();
    if (chromeVisible && !chromeLocked) {
      scheduleChromeHide();
    } else {
      clearChromeTimer();
    }
    return clearChromeTimer;
  }, [chromeVisible, chromeLocked, chromeOpacity, scheduleChromeHide, clearChromeTimer]);

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

  // Remount SurfaceView once after connect so first frame attaches (Android).
  useEffect(() => {
    if (Platform.OS !== 'android' || !isVideo) return undefined;
    if (call.state !== 'connected') return undefined;
    const t = setTimeout(() => {
      setAndroidVideoEpoch((n) => (n === 0 ? 1 : n));
    }, 350);
    return () => clearTimeout(t);
  }, [isVideo, call.state]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (pip.isInPictureInPicture) return;
    androidPipLayoutKeyRef.current = '';
    setAndroidPipSurfaceEpoch(0);
  }, [pip.isInPictureInPicture]);

  const toggleChrome = useCallback(() => {
    if (chromeLocked) {
      setChromeVisible(true);
      return;
    }
    setChromeVisible((prev) => !prev);
  }, [chromeLocked]);

  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    scheduleChromeHide();
  }, [scheduleChromeHide]);

  const handleMinimize = useCallback(() => {
    // Dismiss full-screen call Modal → previous screen + in-app floating video bubble.
    // Android Activity PiP is only for Home/leave (blocks using the app if used here).
    // iOS AVKit system PiP still auto-starts when the app backgrounds (iosPIP props).
    onMinimize?.();
  }, [onMinimize]);

  const swapPrimaryVideo = useCallback(() => {
    setLocalIsPrimary((prev) => !prev);
    bumpChrome();
  }, [bumpChrome]);

  useEffect(() => {
    if (!call.remoteStream) setLocalIsPrimary(false);
  }, [call.remoteStream]);

  if (isVideo) {
    const localStream = call.videoEnabled ? call.localStream : null;
    const remoteStream = call.remoteStream;
    const localIsShown = Boolean(localStream);
    const remoteIsShown = Boolean(remoteStream);
    // Parent CallingUI keeps androidSystemPipActive across ACS remount (Modal→Activity).
    const hideChrome =
      Platform.OS === 'android' && (androidSystemPipActive || pip.isInPictureInPicture);
    /** Both streams → one full + one float; tap float (or full) to swap. */
    const showFloat = remoteIsShown && localIsShown && !hideChrome;
    /** Outgoing / pre-connect: full-bleed local like WhatsApp ringing UI. */
    const fullLocalPhase = localIsShown && !remoteIsShown;
    const primaryIsLocal = hideChrome ? false : showFloat ? localIsPrimary : fullLocalPhase;
    // Android PiP uses a dedicated contain surface (hideChrome). iOS AVKit PiP
    // samples the remote RTCView — switch to contain while PiP is active only.
    const remoteFit =
      Platform.OS === 'ios' && pip.isInPictureInPicture ? ('contain' as const) : ('cover' as const);

    const showLocalCamTopRight =
      call.videoEnabled && (fullLocalPhase || (showFloat && primaryIsLocal));

    const topRightStack = showLocalCamTopRight ? (
      <View style={styles.topRightStack}>
        <RoundIconButton
          label="Flip camera"
          onPress={() => {
            bumpChrome();
            runSafe(() => client.switchCamera(call.callId), onError);
          }}
        >
          <FlipCameraIcon size={18} color="#fff" />
        </RoundIconButton>
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
      </View>
    ) : null;

    const remoteFull = remoteIsShown && !(showFloat && primaryIsLocal);
    const localFull = fullLocalPhase || (showFloat && primaryIsLocal && Boolean(localStream));
    const floatShowsLocal = showFloat && !primaryIsLocal;
    const floatShowsRemote = showFloat && primaryIsLocal;

    return (
      <View style={androidSystemPipActive ? styles.fillPip : styles.fill}>
        <View style={styles.videoLayer} pointerEvents="box-none">
          {!remoteIsShown && !localIsShown ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}

          {/*
            Android PiP only: remounted remote with objectFit=contain.
            Remount on layout size (after real PiP bounds) — early mode events still
            have fullscreen metrics and crop as top-left if surface is created then.
          */}
          {hideChrome && remoteStream ? (
            <View
              collapsable={false}
              style={styles.androidPipFitRoot}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                if (width < 2 || height < 2) return;
                const key = `${Math.round(width)}x${Math.round(height)}`;
                if (key === androidPipLayoutKeyRef.current) return;
                androidPipLayoutKeyRef.current = key;
                setAndroidPipSurfaceEpoch((n) => n + 1);
              }}
            >
              <RemoteVideoView
                key={`pip-remote-${androidPipSurfaceEpoch}`}
                stream={remoteStream as MediaStreamLike}
                objectFit="contain"
                style={styles.fillVideo}
                zOrder={0}
              />
            </View>
          ) : null}

          {!hideChrome && remoteFull && remoteStream ? (
            <View
              ref={androidRemoteLayoutRef}
              key={`remote-slot-${androidVideoEpoch}-${
                typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : 'x'
              }`}
              pointerEvents="none"
              collapsable={false}
              style={styles.fullVideo}
              onLayout={() => {
                if (!pip.isInPictureInPicture) pip.refreshAndroidSourceHint();
              }}
            >
              <RemoteVideoView
                ref={remoteVideoRef}
                stream={remoteStream as MediaStreamLike}
                objectFit={remoteFit}
                style={styles.fillVideo}
                zOrder={0}
                iosPIP={Platform.OS === 'ios' ? iosPipOptions : undefined}
              />
            </View>
          ) : null}

          {!hideChrome && localFull && localStream ? (
            <View
              key={`local-slot-${androidVideoEpoch}-${
                typeof localStream.toURL === 'function' ? localStream.toURL() : 'x'
              }`}
              pointerEvents="none"
              style={styles.fullVideo}
            >
              <LocalVideoView
                stream={localStream as MediaStreamLike}
                mirror={call.facingMode !== 'environment'}
                objectFit="cover"
                style={styles.fillVideo}
                zOrder={0}
              />
            </View>
          ) : null}

          {!hideChrome && !remoteIsShown && !fullLocalPhase ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}
        </View>

        {/*
          Hide on tap only after remote joins. Outgoing preview keeps controls locked.
        */}
        {chromeVisible && !hideChrome && !chromeLocked ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide call controls"
            onPress={toggleChrome}
            style={[styles.chromeHideHit, { top: insets.top + 56, bottom: insets.bottom + 120 }]}
          />
        ) : null}

        {floatShowsLocal && localStream ? (
          <FloatingPipTile
            insets={insets}
            mutedBadge={call.muted}
            chromeVisible={chromeVisible && !hideChrome}
            onTap={swapPrimaryVideo}
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

        {floatShowsRemote && remoteStream ? (
          <FloatingPipTile
            insets={insets}
            mutedBadge={false}
            chromeVisible={chromeVisible && !hideChrome}
            onTap={swapPrimaryVideo}
          >
            <View collapsable={false} style={styles.fillVideo}>
              <RemoteVideoView
                ref={remoteVideoRef}
                stream={remoteStream as MediaStreamLike}
                objectFit={remoteFit}
                style={styles.fillVideo}
                zOrder={1}
                iosPIP={Platform.OS === 'ios' ? iosPipOptions : undefined}
              />
            </View>
          </FloatingPipTile>
        ) : null}

        {!hideChrome ? (
          <>
            <Animated.View
              pointerEvents={chromeVisible || chromeLocked ? 'box-none' : 'none'}
              style={[
                styles.topChromeAbs,
                {
                  paddingTop: insets.top + 6,
                  opacity: chromeOpacity,
                },
              ]}
            >
              <RoundIconButton label="Minimize call" onPress={handleMinimize}>
                <MinimizeIcon size={18} color="#fff" />
              </RoundIconButton>

              <View style={styles.videoHeader} pointerEvents="none">
                {
                  (slots?.renderHeader?.(call) ?? (
                    <Text style={styles.videoName} numberOfLines={1}>
                      {getPeerDisplayName(call)}
                    </Text>
                  )) as React.JSX.Element
                }
                {
                  (slots?.renderStatus?.(call) ?? (
                    <Text style={styles.videoStatus}>
                      {call.state === 'connected' ? elapsedLabel : statusLabel(call)}
                    </Text>
                  )) as React.JSX.Element
                }
              </View>

              {topRightStack ?? <View style={styles.topRightSpacer} />}
            </Animated.View>

            {call.muted || isRemoteMuted(call) ? (
              <View pointerEvents="none" style={[styles.muteBanner, { top: insets.top + 78 }]}>
                <MicOffIcon size={14} color="#fff" />
                <Text style={styles.muteToastText}>
                  {call.muted && isRemoteMuted(call)
                    ? `You are muted · ${getPeerDisplayName(call)} muted`
                    : call.muted
                      ? 'You are muted'
                      : `${getPeerDisplayName(call)} muted`}
                </Text>
              </View>
            ) : null}

            <Animated.View
              pointerEvents={chromeVisible || chromeLocked ? 'box-none' : 'none'}
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
              {
                (slots?.renderControls?.(call) ?? (
                  <CallControls
                    call={call}
                    client={client}
                    theme={theme}
                    onEnd={onEnd}
                    onError={onError}
                  />
                )) as React.JSX.Element
              }
            </Animated.View>
            {(slots?.renderOverlay?.(call) ?? null) as React.JSX.Element | null}
          </>
        ) : null}

        {/* Show on tap after auto-hide / hide — Modal sits above RTCView surface. */}
        {!hideChrome && !chromeLocked && !chromeVisible ? (
          <Modal
            transparent
            visible
            animationType="none"
            statusBarTranslucent
            hardwareAccelerated
            presentationStyle="overFullScreen"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show call controls"
              onPress={toggleChrome}
              style={styles.chromeShowHit}
            />
          </Modal>
        ) : null}
      </View>
    );
  }

  const peerName = getPeerDisplayName(call);
  const peerInitials = getPeerInitials(call);
  const remoteMuted = isRemoteMuted(call);
  const audioStatus = call.state === 'connected' ? elapsedLabel : statusLabel(call);

  const audioContent = (
    <View style={[styles.audioContainer, { paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.audioStage}>
        {
          (slots?.renderAvatar?.(call) ?? (
            <View
              style={[styles.avatar, styles.audioAvatar, { backgroundColor: theme.colors.surface }]}
            >
              <Text style={[styles.avatarText, { color: theme.colors.accent }]}>
                {peerInitials}
              </Text>
            </View>
          )) as React.JSX.Element
        }
        {
          (slots?.renderHeader?.(call) ?? (
            <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
              {peerName}
            </Text>
          )) as React.JSX.Element
        }
        {
          (slots?.renderStatus?.(call) ?? (
            <Text style={[styles.audioStatus, { color: theme.colors.textMuted }]}>
              {audioStatus}
            </Text>
          )) as React.JSX.Element
        }
        {call.muted || remoteMuted ? (
          <View style={styles.audioMuteRow}>
            <MicOffIcon size={14} color={theme.colors.textMuted} />
            <Text style={[styles.audioMuteText, { color: theme.colors.textMuted }]}>
              {call.muted && remoteMuted
                ? `You are muted · ${peerName} muted`
                : call.muted
                  ? 'You are muted'
                  : `${peerName} muted`}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.controlsDock}>
        {
          (slots?.renderControls?.(call) ?? (
            <CallControls
              call={call}
              client={client}
              theme={theme}
              onEnd={onEnd}
              onError={onError}
            />
          )) as React.JSX.Element
        }
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
    <View style={[styles.fill, { backgroundColor: backgroundColor ?? theme.colors.background }]}>
      {audioContent}
    </View>
  );
}

const styles = StyleSheet.create({
  // Modal (Incoming→Active): flex:1 keeps full height before remote video mounts.
  // absoluteFill alone collapses until the remote SurfaceView lays out → controls jump up.
  fill: { flex: 1, backgroundColor: '#000' },
  // Android system PiP Activity host is itself absoluteFill — match that box.
  fillPip: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
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
  /** Android PiP-only: fill Activity window; RTCView objectFit=contain does the letterbox. */
  androidPipFitRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  roundedClip: {
    borderRadius: 16,
    overflow: 'hidden',
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
    borderRadius: 16,
    // Android SurfaceView blanks under overflow:hidden — keep visible.
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 18,
    elevation: 18,
    backgroundColor: '#111',
  },
  chromeToggleHit: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  chromeHideHit: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 15,
    elevation: 15,
  },
  chromeShowHit: {
    flex: 1,
    backgroundColor: 'transparent',
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
  audioStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  avatar: { alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  audioAvatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    marginBottom: 20,
  },
  avatarText: { fontSize: 42, fontWeight: '700' },
  name: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
    maxWidth: '90%',
  },
  audioStatus: {
    fontSize: 16,
    fontWeight: '500',
  },
  audioMuteRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  audioMuteText: {
    fontSize: 13,
    fontWeight: '600',
  },
  miniBubble: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: MINI_W,
    height: MINI_H,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
    zIndex: 100,
    elevation: 30,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
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

function miniBubbleBounds(insets: SafeInsets) {
  const screen = Dimensions.get('screen');
  return {
    minX: 8 + insets.left,
    minY: insets.top + 8,
    maxX: Math.max(8 + insets.left, screen.width - MINI_W - 8 - insets.right),
    maxY: Math.max(insets.top + 8, screen.height - MINI_H - 8 - insets.bottom),
  };
}

function defaultMiniBubbleTopRight(insets: SafeInsets): { x: number; y: number } {
  const b = miniBubbleBounds(insets);
  return { x: b.maxX, y: b.minY + 48 };
}

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
  const remote = call.remoteStream;
  const local = call.videoEnabled ? call.localStream : null;
  const stream = (remote ?? local) as MediaStreamLike | null | undefined;
  const isLocalFallback = !remote && Boolean(local);

  const boundsRef = useRef(miniBubbleBounds(insets));
  boundsRef.current = miniBubbleBounds(insets);

  const pan = useRef(
    new Animated.ValueXY(
      (() => {
        const b = boundsRef.current;
        const saved = persistedMiniBubblePos;
        if (
          saved &&
          saved.x >= b.minX - 1 &&
          saved.x <= b.maxX + 1 &&
          saved.y >= b.minY - 1 &&
          saved.y <= b.maxY + 1
        ) {
          return saved;
        }
        return defaultMiniBubbleTopRight(insets);
      })(),
    ),
  ).current;
  const startRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  useEffect(() => {
    const { minX, minY, maxX, maxY } = boundsRef.current;
    pan.stopAnimation((value) => {
      let nextX = snapFloatXToEdge(clamp(value.x, minX, maxX), minX, maxX, MINI_W);
      let nextY = clamp(value.y, minY, maxY);
      const next = { x: nextX, y: nextY };
      persistedMiniBubblePos = next;
      pan.setValue(next);
    });
  }, [insets.top, insets.bottom, insets.left, insets.right, pan]);

  useEffect(
    () => () => {
      pan.stopAnimation((value) => {
        persistedMiniBubblePos = { x: value.x, y: value.y };
      });
    },
    [pan],
  );

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
          const nextX = snapFloatXToEdge(clamp(value.x, minX, maxX), minX, maxX, MINI_W);
          const nextY = clamp(value.y, minY, maxY);
          const next = { x: nextX, y: nextY };
          persistedMiniBubblePos = next;
          Animated.spring(pan, {
            toValue: next,
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
      <View collapsable={false} style={styles.fillVideo}>
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
            <RemoteVideoView
              stream={stream}
              objectFit="cover"
              style={styles.fillVideo}
              zOrder={2}
            />
          )
        ) : (
          <View style={styles.miniPlaceholder}>
            <Text style={styles.miniPlaceholderText}>{getPeerInitials(call)}</Text>
          </View>
        )}
      </View>
      <View style={styles.miniFooter} pointerEvents="box-none">
        <Text numberOfLines={1} style={styles.miniName}>
          {getPeerDisplayName(call)}
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
