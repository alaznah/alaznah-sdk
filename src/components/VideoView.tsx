import React, { forwardRef, useMemo } from 'react';
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  UIManager,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { silenceWebRtcDebugLogs } from '../debug/webrtcLogging.js';
import type { MediaStreamLike } from '../types/index.js';

export type IosPipOptions = {
  enabled?: boolean;
  startAutomatically?: boolean;
  stopAutomatically?: boolean;
  preferredSize?: { width: number; height: number };
  /**
   * Ignored by @alaznah/calling — system PiP is remote-only.
   * Kept optional for forward-compat with react-native-webrtc prop shapes.
   */
  localStreamURL?: string;
};

export type VideoViewProps = {
  stream: MediaStreamLike | null | undefined;
  mirror?: boolean;
  objectFit?: 'contain' | 'cover';
  style?: StyleProp<ViewStyle> | Record<string, unknown>;
  zOrder?: number;
  /** iOS only — enables system video-call Picture-in-Picture via react-native-webrtc. */
  iosPIP?: IosPipOptions;
  /** iOS PiP fallback (avatar) — reparented into AVKit fallbackView. */
  children?: React.ReactNode;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
};

type RTCViewProps = {
  streamURL: string;
  mirror?: boolean;
  objectFit?: string;
  style?: StyleProp<ViewStyle>;
  zOrder?: number;
  iosPIP?: IosPipOptions;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
};

type AlaznahTextureProps = {
  streamURL: string;
  mirror?: boolean;
  objectFit?: string;
  style?: StyleProp<ViewStyle> | Record<string, unknown>;
  zOrder?: number;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
};

let AlaznahTextureVideoView: React.ComponentType<AlaznahTextureProps> | null | undefined;

function getAndroidTextureView(): React.ComponentType<AlaznahTextureProps> | null {
  if (Platform.OS !== 'android') return null;
  if (AlaznahTextureVideoView !== undefined) return AlaznahTextureVideoView;
  try {
    if (UIManager.getViewManagerConfig('AlaznahTextureVideoView') == null) {
      AlaznahTextureVideoView = null;
      return null;
    }
    AlaznahTextureVideoView =
      requireNativeComponent<AlaznahTextureProps>('AlaznahTextureVideoView');
  } catch {
    AlaznahTextureVideoView = null;
  }
  return AlaznahTextureVideoView;
}

/**
 * Flatten RN style props for native RTCView (iOS Metal).
 *
 * Match Android TextureView styling: caller supplies width/height (fillVideo).
 * Never `{ ...styleArray }` — that drops width/height.
 * Never inject absoluteFill here — that over-crops Metal `objectFit: cover`
 * vs Android's %-sized TextureView.
 * Never pass `flex` — Metal ignores Yoga flex → black / zero frame.
 */
function resolveRtcStyle(style: VideoViewProps['style']): StyleProp<ViewStyle> {
  const flat = StyleSheet.flatten([
    { backgroundColor: '#000' },
    style as StyleProp<ViewStyle>,
  ]) as ViewStyle;
  const { flex: _flex, flexGrow: _fg, flexShrink: _fs, flexBasis: _fb, ...rest } = flat;
  return rest;
}

/**
 * Thin wrapper around react-native-webrtc RTCView (iOS) /
 * Alaznah TextureView renderer (Android).
 *
 * Android uses TextureView so float↔fullscreen layout animation and avatar
 * overlays work; SurfaceViewRenderer hole-punch cannot.
 *
 * Do NOT remount via changing `key` on camera flip — that causes blink.
 * Front/back switch updates the same track in place.
 */
export const VideoView = forwardRef<unknown, VideoViewProps>(function VideoView(
  { stream, mirror = false, objectFit = 'cover', style, zOrder, iosPIP, children, onDimensionsChange },
  ref,
) {
  const streamURL = useMemo(() => {
    if (!stream) return null;
    return typeof stream.toURL === 'function' ? stream.toURL() : stream.id;
  }, [stream]);

  if (!stream || !streamURL) return null;

  const TextureView = getAndroidTextureView();
  if (TextureView) {
    return (
      <TextureView
        streamURL={streamURL}
        mirror={mirror}
        objectFit={objectFit}
        style={[{ backgroundColor: '#000' }, style as StyleProp<ViewStyle>]}
        zOrder={zOrder}
        onDimensionsChange={onDimensionsChange}
      />
    );
  }

  let RTCView: React.ComponentType<RTCViewProps> | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webrtc = require('react-native-webrtc') as {
      RTCView?: React.ComponentType<RTCViewProps>;
    };
    silenceWebRtcDebugLogs();
    RTCView = webrtc.RTCView ?? null;
  } catch {
    return null;
  }

  if (!RTCView) return null;

  return React.createElement(
    RTCView as React.ComponentType<RTCViewProps & { ref?: unknown; children?: React.ReactNode }>,
    {
      ref,
      streamURL,
      mirror,
      objectFit,
      style: resolveRtcStyle(style),
      zOrder,
      iosPIP: Platform.OS === 'ios' ? iosPIP : undefined,
      onDimensionsChange,
    },
    children,
  );
});

export const LocalVideoView = forwardRef<
  unknown,
  Omit<VideoViewProps, 'mirror'> & { mirror?: boolean }
>(function LocalVideoView(props, ref) {
  return <VideoView {...props} ref={ref} mirror={props.mirror ?? true} />;
});

export const RemoteVideoView = forwardRef<unknown, VideoViewProps>(
  function RemoteVideoView(props, ref) {
    return <VideoView {...props} ref={ref} mirror={false} />;
  },
);
