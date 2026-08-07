import React, { forwardRef } from 'react';
import { Platform } from 'react-native';
import type { MediaStreamLike } from '../types/index.js';

export type IosPipOptions = {
  enabled?: boolean;
  startAutomatically?: boolean;
  stopAutomatically?: boolean;
  preferredSize?: { width: number; height: number };
  /** Optional local/self stream URL for WhatsApp-style PiP corner inset. */
  localStreamURL?: string;
};

export type VideoViewProps = {
  stream: MediaStreamLike | null | undefined;
  mirror?: boolean;
  objectFit?: 'contain' | 'cover';
  style?: Record<string, unknown>;
  zOrder?: number;
  /** iOS only — enables system video-call Picture-in-Picture via react-native-webrtc. */
  iosPIP?: IosPipOptions;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
};

type RTCViewProps = {
  streamURL: string;
  mirror?: boolean;
  objectFit?: string;
  style?: Record<string, unknown>;
  zOrder?: number;
  iosPIP?: IosPipOptions;
  onDimensionsChange?: (event: { nativeEvent: { width: number; height: number } }) => void;
};

/**
 * Thin wrapper around react-native-webrtc RTCView.
 * Falls back to null when native view is unavailable (unit tests).
 *
 * Do NOT remount via changing `key` on camera flip — that causes blink.
 * Front/back switch updates the same track in place.
 */
export const VideoView = forwardRef<unknown, VideoViewProps>(function VideoView(
  { stream, mirror = false, objectFit = 'cover', style, zOrder, iosPIP, onDimensionsChange },
  ref,
) {
  if (!stream) return null;

  let RTCView: React.ComponentType<RTCViewProps> | null = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webrtc = require('react-native-webrtc') as {
      RTCView?: React.ComponentType<RTCViewProps>;
    };
    RTCView = webrtc.RTCView ?? null;
  } catch {
    return null;
  }

  if (!RTCView) return null;
  const streamURL = typeof stream.toURL === 'function' ? stream.toURL() : stream.id;

  // Host component typing from RN-WebRTC doesn't include ref; runtime supports it.
  return React.createElement(RTCView as React.ComponentType<RTCViewProps & { ref?: unknown }>, {
    ref,
    streamURL,
    mirror,
    objectFit,
    style: { ...(style ?? {}), backgroundColor: '#000' },
    zOrder,
    iosPIP: Platform.OS === 'ios' ? iosPIP : undefined,
    onDimensionsChange,
  });
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
