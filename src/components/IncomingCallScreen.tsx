import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  ImageBackground,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import type { ActiveCall, MediaStreamLike } from '../types/index.js';
import { LocalVideoView } from './VideoView.js';
import { CallDeclineIcon, ChevronUpIcon, VideoIcon, VideoOffIcon } from './icons.js';
import { AcceptCallBurst, ACCEPT_BTN_SIZE } from './AcceptCallBurst.js';
import type { CallingTheme } from './theme.js';
import type { CallingUISlots } from './ui-types.js';
import { getPeerDisplayName, getPeerInitials } from './peerDisplay.js';

type Props = {
  call: ActiveCall;
  theme: CallingTheme;
  backgroundColor?: string;
  backgroundImage?: ImageSourcePropType;
  slots?: CallingUISlots;
  ringTimeoutMs?: number;
  onAccept: (options?: { videoEnabled?: boolean }) => void;
  onReject: () => void;
};

const ACTION_SIZE = ACCEPT_BTN_SIZE;
const CHEVRON_COUNT = 5;

// ─── Tweak here (IncomingCallScreen.tsx) ───────────────────────────────────
const SWIPE = {
  /** Finger must drag this many px UP to accept (negative = up). Easier: -40. Harder: -80. */
  acceptDy: -56,
  /** Fast flick up also accepts (more negative = needs faster flick). */
  acceptVy: -1.1,
  /** Max upward travel while dragging (px). */
  maxDrag: -110,
  /** After accept, button flies this far up before calling onAccept. */
  flyTo: -140,
  /** How quick the fly-away feels (ms). */
  flyMs: 140,
};

type PreviewStream = MediaStreamLike & {
  getTracks?: () => Array<{ stop: () => void }>;
};

function stopPreview(stream: PreviewStream | null) {
  try {
    stream?.getTracks?.().forEach((t) => t.stop());
  } catch {
    // ignore
  }
}

/** Vertical SVG chevrons — blink cascade travels upward (swipe hint). */
function SwipeUpChevrons() {
  // index 0 = closest to button (bottom), lights first; then wave goes up.
  const opacities = useRef(
    Array.from({ length: CHEVRON_COUNT }, () => new Animated.Value(0)),
  ).current;

  useEffect(() => {
    const stepMs = 240;
    const loops = opacities.map((v, fromBottom) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(fromBottom * stepMs),
          Animated.timing(v, {
            toValue: 1,
            duration: 280,
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: 420,
            useNativeDriver: true,
          }),
          Animated.delay((CHEVRON_COUNT - fromBottom) * stepMs + 280),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [opacities]);

  // Render top → bottom so highest chevron is farthest from the button.
  const topFirst = [...opacities].reverse();
  return (
    <View style={styles.chevronStack} pointerEvents="none">
      {topFirst.map((opacity, i) => (
        <Animated.View key={i} style={[styles.chevronItem, { opacity, marginBottom: -6 }]}>
          <ChevronUpIcon size={18} color="#ffffff" />
        </Animated.View>
      ))}
    </View>
  );
}

/** Exact SVG accept burst + vertical swipe-up (tap does nothing). */
function SwipeAcceptControl({
  isVideo,
  joinWithVideo,
  onAccept,
}: {
  isVideo: boolean;
  joinWithVideo: boolean;
  onAccept: () => void;
}) {
  const dragY = useRef(new Animated.Value(0)).current;
  const accepted = useRef(false);
  const [dragging, setDragging] = useState(false);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
        onPanResponderGrant: () => {
          setDragging(true);
        },
        onPanResponderMove: (_, g) => {
          if (accepted.current) return;
          const next = Math.min(0, Math.max(g.dy, SWIPE.maxDrag));
          dragY.setValue(next);
        },
        onPanResponderRelease: (_, g) => {
          if (accepted.current) return;
          if (g.dy <= SWIPE.acceptDy || g.vy < SWIPE.acceptVy) {
            accepted.current = true;
            Animated.timing(dragY, {
              toValue: SWIPE.flyTo,
              duration: SWIPE.flyMs,
              useNativeDriver: true,
            }).start(() => onAccept());
            return;
          }
          setDragging(false);
          Animated.spring(dragY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 6,
          }).start();
        },
        onPanResponderTerminate: () => {
          if (accepted.current) return;
          setDragging(false);
          Animated.spring(dragY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 6,
          }).start();
        },
      }),
    [dragY, onAccept],
  );

  return (
    <View style={styles.actionCol} {...pan.panHandlers}>
      <SwipeUpChevrons />
      <Animated.View
        accessibilityRole="adjustable"
        accessibilityLabel="Swipe up to accept"
        style={{ transform: [{ translateY: dragY }] }}
      >
        <AcceptCallBurst isVideo={isVideo && joinWithVideo} paused={dragging} />
      </Animated.View>
      <Text style={styles.actionLabel}>Swipe up to accept</Text>
    </View>
  );
}

/**
 * Incoming video/audio call — local preview, avatar, Decline / swipe-up Accept.
 */
export function IncomingCallScreen({
  call,
  theme,
  backgroundColor,
  backgroundImage,
  slots,
  onAccept,
  onReject,
}: Props) {
  const isVideo = call.mediaType === 'video';
  const [joinWithVideo, setJoinWithVideo] = useState(isVideo);
  const [preview, setPreview] = useState<PreviewStream | null>(null);
  const previewRef = useRef<PreviewStream | null>(null);

  useEffect(() => {
    if (!isVideo) return undefined;

    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { mediaDevices } = require('react-native-webrtc') as {
          mediaDevices: {
            getUserMedia: (c: object) => Promise<PreviewStream>;
          };
        };
        const stream = await mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user' },
        });
        if (cancelled) {
          stopPreview(stream);
          return;
        }
        previewRef.current = stream;
        setPreview(stream);
      } catch {
        // Preview is best-effort; UI still works without camera.
      }
    })();
    return () => {
      cancelled = true;
      stopPreview(previewRef.current);
      previewRef.current = null;
    };
  }, [call.callId, isVideo]);

  const releasePreview = useCallback(() => {
    stopPreview(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }, []);

  const handleAccept = useCallback(() => {
    // Free the camera for CallManager, but do NOT setPreview(null) here —
    // that unmounts the nested chrome Modal one frame before Active mounts and
    // makes the whole Incoming→Active transition jump.
    stopPreview(previewRef.current);
    previewRef.current = null;
    onAccept({ videoEnabled: isVideo ? joinWithVideo : false });
  }, [isVideo, joinWithVideo, onAccept]);

  const handleReject = useCallback(() => {
    releasePreview();
    onReject();
  }, [onReject, releasePreview]);

  const initials = getPeerInitials(call);
  const peerName = getPeerDisplayName(call);

  const showLivePreview = Boolean(isVideo && preview && joinWithVideo);

  const chrome = (
    <>
      <View style={styles.top} pointerEvents="box-none">
        {
          (slots?.renderHeader?.(call) ?? (
            <Text style={styles.name}>{peerName}</Text>
          )) as React.JSX.Element
        }
        {
          (slots?.renderStatus?.(call) ?? (
            <Text style={styles.subId}>Incoming {isVideo ? 'video' : 'audio'} call</Text>
          )) as React.JSX.Element
        }

        {
          (slots?.renderAvatar?.(call) ?? (
            <View style={[styles.avatar, { backgroundColor: theme.colors.surface }]}>
              <Text style={[styles.avatarText, { color: theme.colors.accent }]}>{initials}</Text>
            </View>
          )) as React.JSX.Element
        }

        {isVideo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={joinWithVideo ? 'Turn off your video' : 'Turn on your video'}
            onPress={() => setJoinWithVideo((v) => !v)}
            style={({ pressed }) => [styles.videoPill, { opacity: pressed ? 0.85 : 1 }]}
          >
            {joinWithVideo ? (
              <VideoOffIcon size={18} color="#fff" />
            ) : (
              <VideoIcon size={18} color="#fff" />
            )}
            <Text style={styles.videoPillText}>
              {joinWithVideo ? 'Turn off your video' : 'Turn on your video'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.bottom} pointerEvents="box-none">
        {
          (slots?.renderControls?.(call) ?? (
            <View style={styles.actions}>
              <View style={styles.actionCol}>
                {/* Same height as accept chevron stack so Decline / Accept circles line up */}
                <View style={styles.chevronStack} pointerEvents="none" />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Decline"
                  onPress={handleReject}
                  style={styles.actionHit}
                >
                  <CallDeclineIcon size={ACTION_SIZE} />
                </Pressable>
                <Text style={styles.actionLabel}>Decline</Text>
              </View>

              <SwipeAcceptControl
                isVideo={isVideo}
                joinWithVideo={joinWithVideo}
                onAccept={handleAccept}
              />
            </View>
          )) as React.JSX.Element
        }
      </View>

      {(slots?.renderOverlay?.(call) ?? null) as React.JSX.Element | null}
    </>
  );

  const content = (
    <View style={styles.stage}>
      {showLivePreview ? (
        <View style={styles.previewLayer} pointerEvents="none" collapsable={false}>
          <LocalVideoView
            stream={preview}
            mirror
            objectFit="cover"
            style={styles.fillVideo}
            zOrder={0}
          />
          <View style={styles.previewDim} />
        </View>
      ) : (
        <View
          style={[
            styles.previewLayer,
            { backgroundColor: backgroundColor ?? theme.colors.background },
          ]}
        />
      )}

      {/*
        Parent CallingUI keeps one Modal; this nested chrome Modal only covers Accept/Decline
        above RTCView (both platforms). Swapping Incoming→Active children unmounts it cleanly.
      */}
      {showLivePreview ? (
        <Modal
          transparent
          visible
          animationType="none"
          statusBarTranslucent
          hardwareAccelerated
          presentationStyle="overFullScreen"
        >
          <View style={styles.container} pointerEvents="box-none">
            {chrome}
          </View>
        </Modal>
      ) : (
        <View style={styles.container} pointerEvents="box-none">
          {chrome}
        </View>
      )}
    </View>
  );

  if (backgroundImage && !showLivePreview) {
    return (
      <ImageBackground source={backgroundImage} style={styles.fill} resizeMode="cover">
        {content}
      </ImageBackground>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: backgroundColor ?? theme.colors.background }]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b1220' },
  stage: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
    paddingTop: 64,
  },
  previewLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0b1220',
    zIndex: 0,
  },
  fillVideo: { width: '100%', height: '100%' },
  previewDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  top: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 12,
    zIndex: 2,
  },
  name: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  subId: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.88)',
    fontSize: 15,
    textAlign: 'center',
  },
  avatar: {
    marginTop: 48,
    width: 128,
    height: 128,
    borderRadius: 64,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#3b82f6',
    fontSize: 44,
    fontWeight: '700',
  },
  videoPill: {
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(40,40,40,0.72)',
  },
  videoPillText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  bottom: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 28,
    zIndex: 3,
    elevation: 8,
  },
  actions: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: 300,
    justifyContent: 'space-evenly',
    alignItems: 'flex-start',
    alignSelf: 'center',
    paddingHorizontal: 8,
  },
  actionCol: {
    width: 120,
    alignItems: 'center',
    gap: 8,
  },
  actionHit: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  chevronStack: {
    height: 80,
    width: 28,
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  chevronItem: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    minHeight: 32,
  },
});
