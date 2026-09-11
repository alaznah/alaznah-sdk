import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  ImageBackground,
  Modal,
  NativeModules,
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
import {
  getPeerDisplayName,
  getPeerInitials,
  getPeerAvatarUrl,
  getLocalInitials,
  getLocalAvatarUrl,
  isRemoteMuted,
  isRemoteVideoEnabled,
} from './peerDisplay.js';

type SafeInsets = { top: number; bottom: number; left: number; right: number };

/** iOS: one AVKit controller on the in-Modal remote RTCView (last working Home PiP). */
const IOS_PIP = {
  enabled: true,
  startAutomatically: true,
  stopAutomatically: true,
  preferredSize: { width: 160, height: 284 },
} as const;

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
    const mod = require('react-native-safe-area-context') as {
      useSafeAreaInsets: () => SafeInsets;
      initialWindowMetrics: { insets: SafeInsets } | null;
    };
    const insets = mod.useSafeAreaInsets();
    // Modal without a nested provider reports 0 top on iOS — fall back to
    // window metrics so chrome never sits under the notch on first paint.
    if (
      Platform.OS === 'ios' &&
      insets.top < 1 &&
      mod.initialWindowMetrics?.insets &&
      mod.initialWindowMetrics.insets.top > 0
    ) {
      return mod.initialWindowMetrics.insets;
    }
    return insets;
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
  /** Enter native OS Picture-in-Picture; host hides the call Modal so the app stays usable. */
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
  /** When true, tile fills the screen — same mounted children, layout-only change. */
  expanded = false,
  /** Optional host ref for Android PiP source layout hints. */
  hostRef,
}: {
  insets: SafeInsets;
  mutedBadge?: boolean;
  chromeVisible: boolean;
  onTap: () => void;
  overlay?: React.JSX.Element | null;
  children: React.JSX.Element;
  expanded?: boolean;
  hostRef?: React.RefObject<View | null>;
}) {
  // Animate layout W/H + dock pan. Keep RTCView mounted (no video blink).
  const screen = Dimensions.get('screen');
  const { w: tileW, h: tileH } = expanded
    ? { w: screen.width, h: screen.height }
    : floatTileSize(chromeVisible);
  const tileSizeRef = useRef({ w: tileW, h: tileH });
  tileSizeRef.current = { w: tileW, h: tileH };

  const boundsRef = useRef(floatBounds(insets, chromeVisible, tileW, tileH));
  boundsRef.current = floatBounds(insets, chromeVisible, tileW, tileH);

  const widthAnim = useRef(new Animated.Value(tileW)).current;
  const heightAnim = useRef(new Animated.Value(tileH)).current;

  const pan = useRef(
    new Animated.ValueXY(
      (() => {
        if (expanded) return { x: 0, y: 0 };
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
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const prevExpandedRef = useRef(expanded);

  useEffect(() => {
    const { w, h } = tileSizeRef.current;
    const ease = Easing.bezier(0.22, 1, 0.36, 1);
    const leavingExpanded = prevExpandedRef.current && !expanded;
    prevExpandedRef.current = expanded;

    if (expanded) {
      // Save float dock before expanding so we can restore (or default TR) later.
      pan.stopAnimation((value) => {
        if (Math.abs(value.x) > 2 || Math.abs(value.y) > 2) {
          persistedFloatPos = { x: value.x, y: value.y };
        }
      });
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
          toValue: 0,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
        Animated.timing(pan.y, {
          toValue: 0,
          duration: FLOAT_SIZE_MS,
          easing: ease,
          useNativeDriver: false,
        }),
      ]).start();
      return;
    }

    const { minX, minY, maxX, maxY } = boundsRef.current;

    pan.stopAnimation((value) => {
      let placed: { x: number; y: number };

      if (leavingExpanded) {
        // Expanded sits at (0,0). Snapping from that origin wrongly docks top-left.
        // Prefer saved float position; otherwise default top-right (safe-area aware).
        const saved = persistedFloatPos;
        const savedOk =
          saved &&
          saved.x >= minX - 1 &&
          saved.x <= maxX + 1 &&
          saved.y >= minY - 1 &&
          saved.y <= maxY + 1;
        placed = savedOk ? saved : defaultFloatTopRight(insets, w);
      } else {
        const onRight = Math.abs(value.x - maxX) <= Math.abs(value.x - minX);
        const onBottom = Math.abs(value.y - maxY) <= Math.abs(value.y - minY);
        let nextX = clamp(value.x, minX, maxX);
        let nextY = clamp(value.y, minY, maxY);
        if (onRight) nextX = maxX;
        if (onBottom) nextY = maxY;
        const nearCorner =
          (nextX <= minX + 2 || nextX >= maxX - 2) && (nextY <= minY + 2 || nextY >= maxY - 2);
        placed = nearCorner
          ? snapFloatToCorner(nextX, nextY, minX, minY, maxX, maxY, w, h)
          : { x: nextX, y: nextY };
      }
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
    expanded,
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
      if (expandedRef.current) return;
      pan.stopAnimation((value) => {
        persistedFloatPos = { x: value.x, y: value.y };
      });
    },
    [pan],
  );

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !expandedRef.current,
      onStartShouldSetPanResponderCapture: () => !expandedRef.current,
      onMoveShouldSetPanResponder: (_, g) =>
        !expandedRef.current && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
      onMoveShouldSetPanResponderCapture: (_, g) =>
        !expandedRef.current && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => !expandedRef.current,
      onPanResponderGrant: () => {
        if (expandedRef.current) return;
        movedRef.current = false;
        pan.stopAnimation((value) => {
          startRef.current = { x: value.x, y: value.y };
          pan.setOffset(value);
          pan.setValue({ x: 0, y: 0 });
        });
      },
      onPanResponderMove: (_, g) => {
        if (expandedRef.current) return;
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
        if (expandedRef.current) return;
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
      ref={hostRef as never}
      collapsable={false}
      pointerEvents={expanded ? 'none' : 'box-none'}
      style={[
        styles.floatTile,
        expanded ? styles.floatTileExpanded : null,
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
      <View
        collapsable={false}
        style={styles.fillVideo}
        {...(expanded ? {} : responder.panHandlers)}
      >
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

function CallVideoAvatar({
  initials,
  theme,
  compact,
  imageUri,
}: {
  initials: string;
  theme: CallingTheme;
  compact?: boolean;
  imageUri?: string;
}) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const minSide = Math.min(box.w, box.h);
  // Size circle from the participant container. Guard against pre-layout /
  // tiny bounds — Android Fabric crashes on fontSize <= 0.
  const fallback = compact ? 56 : 120;
  const ratio = compact ? 0.45 : 0.28;
  const maxSide = compact ? 72 : 168;
  const minCircle = compact ? 40 : 88;
  const circle =
    minSide >= minCircle
      ? Math.round(Math.min(Math.max(minSide * ratio, minCircle), maxSide))
      : minSide > 0
        ? Math.max(24, Math.round(minSide * (compact ? 0.55 : 0.4)))
        : fallback;
  const fontSize = Math.max(12, Math.round(circle * 0.34));

  return (
    <View
      collapsable={false}
      style={[
        // Android: keep working flex fill. iOS: % fill so the circle centers in
        // the participant/avatar layer (flex:1 inside absoluteFill pins to top).
        Platform.OS === 'ios' ? styles.videoAvatarHostIos : styles.videoAvatarHost,
        { backgroundColor: theme.colors.surface },
      ]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== box.w || height !== box.h) {
          setBox({ w: width, h: height });
        }
      }}
    >
      <View
        style={[
          styles.videoAvatarCircleBase,
          {
            width: circle,
            height: circle,
            borderRadius: circle / 2,
            backgroundColor: theme.colors.overlay,
          },
        ]}
      >
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={{
              width: circle,
              height: circle,
              borderRadius: circle / 2,
            }}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={[styles.videoAvatarText, { fontSize, color: theme.colors.accent }]}>
            {initials}
          </Text>
        )}
      </View>
    </View>
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
  /** Android TextureView/Surface attach epoch — remount once after connect if needed. */
  const [androidVideoEpoch, setAndroidVideoEpoch] = useState(0);
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

  // Remount Android video once after connect so first frame attaches.
  useEffect(() => {
    if (Platform.OS !== 'android' || !isVideo) return undefined;
    if (call.state !== 'connected') return undefined;
    const t = setTimeout(() => {
      setAndroidVideoEpoch((n) => (n === 0 ? 1 : n));
    }, 350);
    return () => clearTimeout(t);
  }, [isVideo, call.state]);

  const androidPipUiActive =
    Platform.OS === 'android' &&
    (androidSystemPipActive || pip.isInPictureInPicture);
  /**
   * iOS: after PiP stops, keep chrome/float suppressed briefly so the local
   * float doesn't animate in during the system dismiss. Call UI itself snaps
   * on at native didStop (no L→R slide).
   */
  const [iosPipExitHold, setIosPipExitHold] = useState(false);
  const iosWasInPipRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    if (pip.isInPictureInPicture) {
      iosWasInPipRef.current = true;
      setLocalIsPrimary(false);
      setIosPipExitHold(false);
      return undefined;
    }
    if (!iosWasInPipRef.current) return undefined;
    iosWasInPipRef.current = false;
    setLocalIsPrimary(false);
    setIosPipExitHold(true);
    const timer = setTimeout(() => setIosPipExitHold(false), 300);
    return () => clearTimeout(timer);
  }, [pip.isInPictureInPicture]);

  const iosPipChromeSuppressed =
    Platform.OS === 'ios' && (pip.isInPictureInPicture || iosPipExitHold);
  const suppressCallChrome = androidPipUiActive || iosPipChromeSuppressed;

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
    // iOS: same AVKit PiP as Home — only request startPIP once; lifecycle
    // (pass-through / chrome / exit) is identical to auto Home PiP.
    if (Platform.OS === 'ios') {
      const native = NativeModules.AlaznahCallingPip as
        | { enter?: () => Promise<boolean> }
        | undefined;
      void native?.enter?.();
      return;
    }
    if (onMinimize) {
      onMinimize();
      return;
    }
    void pip.enter();
  }, [onMinimize, pip]);

  const swapPrimaryVideo = useCallback(() => {
    setLocalIsPrimary((prev) => !prev);
    bumpChrome();
  }, [bumpChrome]);

  useEffect(() => {
    if (!call.remoteStream) setLocalIsPrimary(false);
  }, [call.remoteStream]);

  if (isVideo) {
    const remoteStream = call.remoteStream;
    // Keep stream handle even when camera-off so the tile stays mounted for avatars.
    const localStreamHandle = call.localStream;
    const showLocalVideo = Boolean(call.videoEnabled && localStreamHandle);
    // Video call always keeps a local tile (camera preview or avatar) — never empty.
    const showLocalAvatar = call.mediaType === 'video' && !showLocalVideo;
    const localIsShown = showLocalVideo || showLocalAvatar;
    const remoteIsShown = Boolean(remoteStream);
    const showRemoteVideo = Boolean(remoteStream && isRemoteVideoEnabled(call));
    // Parent CallingUI keeps androidSystemPipActive across ACS remount (Modal→Activity).
    // Android: hideChrome unmounts RTCViews so native TextureView owns the track.
    // iOS: never unmount remote — only suppress chrome/local float while PiP runs
    // so restore morphs into the same remote surface (not an "old screen").
    const hideChrome = androidPipUiActive;
    const suppressChrome = suppressCallChrome;
    /** Both streams → one full + one float; tap float (or full) to swap. */
    const showFloat = remoteIsShown && localIsShown && !suppressChrome;
    /** Outgoing / pre-connect: full-bleed local like WhatsApp ringing UI. */
    const fullLocalPhase = localIsShown && !remoteIsShown;
    const primaryIsLocal = suppressChrome ? false : showFloat ? localIsPrimary : fullLocalPhase;
    const remoteFull = remoteIsShown && !(showFloat && primaryIsLocal);
    const localFull = fullLocalPhase || (showFloat && primaryIsLocal && localIsShown);
    const floatShowsLocal = showFloat && !primaryIsLocal;
    const floatShowsRemote = showFloat && primaryIsLocal;

    // Android PiP: native TextureView overlay owns the live remote track.
    // Unmount inline video here so its renderer cannot fight the PiP surface.
    //
    // iOS/Android inline: cover = fullscreen remote (pre-PiP behavior).
    // PiP sample-buffer gravity stays ResizeAspect via the webrtc patch —
    // do NOT switch this to contain (that letterboxed the normal call UI).
    const remoteFit = 'cover' as const;

    /** iOS: keep a full-bleed remote RTCView mounted for inline display
     * even when the user swaps local to primary. One AVKit controller lives
     * on this view (in the call Modal / key window). */
    const mountIosPipSource =
      Platform.OS === 'ios' && remoteIsShown && Boolean(remoteStream) && !hideChrome;
    /**
     * Android: one FloatingPipTile for remote (expanded↔float) — never remount
     * the video renderer on swap. iOS keeps the dual full-slot + float path for
     * inline Metal; AVKit PiP is the in-Modal remote RTCView, not a second source.
     */
    const mountAndroidRemoteTile =
      Platform.OS === 'android' && remoteIsShown && Boolean(remoteStream) && !hideChrome;
    const mountRemoteFullSlot = mountIosPipSource;

    /** One local surface for float↔fullscreen — remounting on swap blacks Metal / glitches Android. */
    const mountLocalTile =
      !suppressChrome && localIsShown && (localFull || floatShowsLocal);

    const localInitials = getLocalInitials(call);
    const localAvatarUri = getLocalAvatarUrl(call);
    const peerInitialsVideo = getPeerInitials(call);
    const peerAvatarUri = getPeerAvatarUrl(call);
    const compactLocal = !localFull;
    const compactRemote = !remoteFull;
    const remoteMutedOnly = isRemoteMuted(call);

    const showLocalCamTopRight =
      showLocalVideo && (fullLocalPhase || (showFloat && primaryIsLocal));

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

    const remoteVideoTrackId =
      remoteStream && typeof remoteStream.getVideoTracks === 'function'
        ? remoteStream.getVideoTracks()[0]?.id
        : undefined;

    // Golden reference (Android): unmount video when OFF, mount avatar in the
    // SAME participantSurface. iOS local + iOS float remote use this identical
    // tree. iOS full-bleed remote (PiP source) keeps RTCView mounted but parks
    // it out of flex flow when OFF so the avatar gets the same flex geometry.
    const localSurface = (
      <View collapsable={false} style={styles.participantSurface}>
        {showLocalVideo && localStreamHandle ? (
          <LocalVideoView
            stream={localStreamHandle as MediaStreamLike}
            mirror={call.facingMode !== 'environment'}
            objectFit="cover"
            style={styles.fillVideo}
            zOrder={localFull ? 0 : 1}
          />
        ) : null}
        {showLocalAvatar ? (
          <CallVideoAvatar
            initials={localInitials}
            imageUri={localAvatarUri}
            theme={theme}
            compact={compactLocal}
          />
        ) : null}
      </View>
    );

    const remoteParticipantSurface = (
      <View collapsable={false} style={styles.participantSurface}>
        {showRemoteVideo && remoteStream ? (
          <RemoteVideoView
            stream={remoteStream as MediaStreamLike}
            objectFit={remoteFit}
            style={styles.fillVideo}
            zOrder={remoteFull ? 0 : 1}
          />
        ) : null}
        {!showRemoteVideo ? (
          <CallVideoAvatar
            initials={peerInitialsVideo}
            imageUri={peerAvatarUri}
            theme={theme}
            compact={compactRemote}
          />
        ) : null}
      </View>
    );

    return (
      <View style={styles.fill}>
        <View style={styles.videoLayer} pointerEvents="box-none">
          {!remoteIsShown && !localIsShown && !suppressChrome ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}

          {mountRemoteFullSlot && remoteStream ? (
            <View
              ref={androidRemoteLayoutRef}
              key={`remote-slot-${androidVideoEpoch}-${
                typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : 'x'
              }`}
              pointerEvents="none"
              collapsable={false}
              style={[styles.fullVideo, !remoteFull ? styles.iosPipSourceHidden : null]}
              onLayout={() => {
                if (!pip.isInPictureInPicture) pip.refreshAndroidSourceHint();
              }}
            >
              <RemoteVideoView
                key={`ios-remote-track-${remoteVideoTrackId ?? 'pending'}`}
                ref={remoteVideoRef}
                stream={remoteStream as MediaStreamLike}
                objectFit={remoteFit}
                style={showRemoteVideo ? styles.fillVideo : styles.iosPipSourceParked}
                zOrder={0}
                iosPIP={Platform.OS === 'ios' ? IOS_PIP : undefined}
              />
              {!showRemoteVideo ? (
                <View
                  style={[
                    styles.iosRemoteAvatarLayer,
                    { backgroundColor: theme.colors.surface },
                  ]}
                  pointerEvents="none"
                >
                  {((slots?.renderAvatar?.(call) as React.JSX.Element | null | undefined) ?? (
                    <CallVideoAvatar
                      initials={peerInitialsVideo}
                      imageUri={peerAvatarUri}
                      theme={theme}
                      compact={compactRemote}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {!suppressChrome && !remoteIsShown && !fullLocalPhase ? (
            <View style={[styles.placeholder, { backgroundColor: theme.colors.overlay }]}>
              <Text style={{ color: theme.colors.text }}>{statusLabel(call)}</Text>
            </View>
          ) : null}
        </View>

        {/*
          Hide on tap only after remote joins. Outgoing preview keeps controls locked.
        */}
        {chromeVisible && !suppressChrome && !chromeLocked ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide call controls"
            onPress={toggleChrome}
            style={[styles.chromeHideHit, { top: insets.top + 56, bottom: insets.bottom + 120 }]}
          />
        ) : null}

        {mountAndroidRemoteTile ? (
          <FloatingPipTile
            insets={insets}
            expanded={remoteFull}
            hostRef={androidRemoteLayoutRef}
            mutedBadge={remoteMutedOnly && !remoteFull}
            chromeVisible={chromeVisible && !suppressChrome}
            onTap={showFloat ? swapPrimaryVideo : () => undefined}
          >
            <View
              collapsable={false}
              style={styles.fillVideo}
              onLayout={() => {
                if (remoteFull && !pip.isInPictureInPicture) pip.refreshAndroidSourceHint();
              }}
            >
              {remoteParticipantSurface}
            </View>
          </FloatingPipTile>
        ) : null}

        {mountLocalTile ? (
          <FloatingPipTile
            insets={insets}
            expanded={localFull}
            mutedBadge={false}
            chromeVisible={chromeVisible && !suppressChrome}
            onTap={showFloat ? swapPrimaryVideo : () => undefined}
            overlay={
              <LocalCameraOverlayButtons
                call={call}
                client={client}
                onError={onError}
                visible={chromeVisible && !suppressChrome && floatShowsLocal && showLocalVideo}
              />
            }
          >
            {localSurface}
          </FloatingPipTile>
        ) : null}

        {Platform.OS === 'ios' && floatShowsRemote && remoteStream ? (
          <FloatingPipTile
            insets={insets}
            mutedBadge={remoteMutedOnly}
            chromeVisible={chromeVisible && !suppressChrome}
            onTap={swapPrimaryVideo}
          >
            {/*
              Visual float only — no iosPIP here (full-bleed slot owns PiP).
              Same Android video↔avatar unmount swap.
            */}
            <View
              collapsable={false}
              style={styles.participantSurface}
            >
              {showRemoteVideo ? (
                <RemoteVideoView
                  key={`ios-float-remote-${remoteVideoTrackId ?? 'pending'}`}
                  stream={remoteStream as MediaStreamLike}
                  objectFit={remoteFit}
                  style={styles.fillVideo}
                  zOrder={1}
                />
              ) : null}
              {!showRemoteVideo ? (
                <CallVideoAvatar
                  initials={peerInitialsVideo}
                  imageUri={peerAvatarUri}
                  theme={theme}
                  compact
                />
              ) : null}
            </View>
          </FloatingPipTile>
        ) : null}

        {!suppressChrome ? (
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

            {remoteMutedOnly ? (
              <View pointerEvents="none" style={[styles.muteBanner, { top: insets.top + 78 }]}>
                <MicOffIcon size={14} color="#fff" />
                <Text style={styles.muteToastText}>
                  {`${getPeerDisplayName(call)} muted`}
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
        {!suppressChrome && !chromeLocked && !chromeVisible ? (
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
        {remoteMuted ? (
          <View style={styles.audioMuteRow}>
            <MicOffIcon size={14} color={theme.colors.textMuted} />
            <Text style={[styles.audioMuteText, { color: theme.colors.textMuted }]}>
              {`${peerName} muted`}
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
  // absoluteFill alone can collapse before the remote renderer lays out.
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
  /** Keep full-screen layout for AVKit sourceView; hide when local is primary. */
  iosPipSourceHidden: {
    opacity: 0,
  },
  /**
   * iOS PiP source when remote camera OFF — stay mounted for AVKit, leave flex
   * flow so the avatar layer owns the visible participant surface.
   */
  iosPipSourceParked: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0,
  },
  /**
   * Opaque avatar cover above parked Metal when remoteVideoEnabled is false.
   * Fill the same fullVideo bounds as the remote renderer; flex-center the
   * avatar (do not leave a content-sized host pinned to the top / status bar).
   */
  iosRemoteAvatarLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fillVideo: {
    // No flex — iOS RTCMTLVideoView + flex collapses to a black surface.
    width: '100%',
    height: '100%',
  },
  /** Same bounds as the video tile — avatar/video swap inside this box only. */
  participantSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignSelf: 'stretch',
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
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 18,
    elevation: 18,
    backgroundColor: '#111',
  },
  floatTileExpanded: {
    borderRadius: 0,
    borderWidth: 0,
    zIndex: 0,
    elevation: 0,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  videoHidden: {
    opacity: 0,
  },
  /** Fills participantSurface and centers the circular avatar (Android golden path). */
  videoAvatarHost: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** iOS — fill parent bounds without flex (avoids top-pinned avatar in absolute layers). */
  videoAvatarHostIos: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoAvatarCircleBase: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  videoAvatarText: {
    fontWeight: '700',
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
