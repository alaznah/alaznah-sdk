import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  findNodeHandle,
  NativeEventEmitter,
  NativeModules,
  Platform,
  UIManager,
  type View,
} from 'react-native';
import { silenceWebRtcDebugLogs } from '../debug/webrtcLogging.js';

type PipNative = {
  setEnabled: (enabled: boolean) => Promise<boolean>;
  enter: () => Promise<boolean>;
  isSupported: () => Promise<boolean>;
  isActive?: () => Promise<boolean>;
  setRemoteStreamUrl?: (url: string) => Promise<boolean>;
  updatePictureInPicture?: (
    width: number,
    height: number,
    x: number,
    y: number,
  ) => Promise<boolean>;
};

function getPipNative(): PipNative | null {
  const mod = NativeModules.AlaznahCallingPip as PipNative | undefined;
  if (!mod?.setEnabled || !mod?.enter) return null;
  return mod;
}

function pushAndroidPipParams(layoutRef: RefObject<View | null>): void {
  if (Platform.OS !== 'android') return;
  const native = getPipNative();
  const update = native?.updatePictureInPicture;
  const node = layoutRef.current;
  if (!update || !node) return;
  node.measureInWindow((x, y, width, height) => {
    if (width < 2 || height < 2) return;
    void update(width, height, x, y).catch(() => undefined);
  });
}

function startIosWebRtcPip(ref: RefObject<unknown>): boolean {
  try {
    const current = ref.current as { __nativeTag?: number; _nativeTag?: number } | null;
    const node =
      findNodeHandle(ref.current as never) ??
      current?.__nativeTag ??
      current?._nativeTag ??
      null;
    if (node == null) return false;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webrtc = require('react-native-webrtc') as {
      startIOSPIP?: (ref: RefObject<unknown>) => void;
    };
    silenceWebRtcDebugLogs();
    if (typeof webrtc.startIOSPIP === 'function') {
      webrtc.startIOSPIP(ref);
      return true;
    }

    const config = UIManager.getViewManagerConfig?.('RTCVideoView') as
      | { Commands?: { startIOSPIP?: number } }
      | undefined;
    const command = config?.Commands?.startIOSPIP;
    if (command == null) return false;
    UIManager.dispatchViewManagerCommand(node, command, []);
    return true;
  } catch {
    return false;
  }
}

async function startIosPipViaNativeModule(): Promise<boolean> {
  const native = NativeModules.AlaznahCallingPip as
    | { enter?: () => Promise<boolean> }
    | undefined;
  if (!native?.enter) return false;
  try {
    return Boolean(await native.enter());
  } catch {
    return false;
  }
}

/**
 * Arm Android native PiP (stream URL + enable flag).
 * Home enter is onUserLeaveHint → MainActivity.enterPictureInPictureMode.
 * Minimize enter is CallingUI → AlaznahPipActivity. Same renderer either way.
 */
export function useAndroidPipArming(enabled: boolean, streamUrl?: string | null): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const native = getPipNative();
    if (!native) return undefined;
    void native.setEnabled(enabled).catch(() => undefined);
    return () => {
      void native.setEnabled(false).catch(() => undefined);
    };
  }, [enabled]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const native = getPipNative();
    const setUrl = native?.setRemoteStreamUrl;
    if (!setUrl) return undefined;
    void setUrl(enabled ? streamUrl ?? '' : '').catch(() => undefined);
    return undefined;
  }, [enabled, streamUrl]);
}

/**
 * Picture-in-Picture for an active video call.
 *
 * Android: AlaznahPipVideoController TextureView (Home: host Activity PiP,
 *          Minimize: AlaznahPipActivity). Restore drops that overlay.
 * iOS: one AVKit PIPController on ActiveCallScreen's in-Modal remote RTCView.
 *      Native lifecycle is forwarded via AlaznahCallingPipModeChanged.
 */
export function useCallPictureInPicture(options: {
  enabled: boolean;
  iosRemoteVideoRef?: RefObject<unknown>;
  androidVideoLayoutRef?: RefObject<View | null>;
  /** When true, this hook owns setEnabled (iOS-only path). Android uses useAndroidPipArming. */
  ownAndroidArming?: boolean;
}): {
  supported: boolean;
  isInPictureInPicture: boolean;
  enter: () => Promise<boolean>;
  refreshAndroidSourceHint: () => void;
} {
  const [supported, setSupported] = useState(Platform.OS === 'android' || Platform.OS === 'ios');
  const [isInPictureInPicture, setIsInPictureInPicture] = useState(false);
  const enabledRef = useRef(options.enabled);
  enabledRef.current = options.enabled;
  const iosRef = options.iosRemoteVideoRef;
  const androidLayoutRef = options.androidVideoLayoutRef;
  const inPipRef = useRef(false);
  inPipRef.current = isInPictureInPicture;
  const ownAndroidArming = options.ownAndroidArming === true;

  const refreshAndroidSourceHint = () => {
    if (inPipRef.current) return;
    if (androidLayoutRef) pushAndroidPipParams(androidLayoutRef);
  };

  useEffect(() => {
    if (Platform.OS === 'ios') {
      setSupported(true);
      const pipMod = NativeModules.AlaznahCallingPip;
      if (!pipMod) return undefined;
      const emitter = new NativeEventEmitter(pipMod);
      const sub = emitter.addListener(
        'AlaznahCallingPipModeChanged',
        (payload: { active?: boolean }) => {
          if (!enabledRef.current) return;
          setIsInPictureInPicture(Boolean(payload?.active));
        },
      );
      return () => {
        sub.remove();
        setIsInPictureInPicture(false);
      };
    }

    const native = getPipNative();
    if (!native) {
      setSupported(false);
      return undefined;
    }

    void native.isSupported().then((ok) => setSupported(Boolean(ok)));
    if (ownAndroidArming) {
      void native.setEnabled(options.enabled).catch(() => undefined);
    }

    const emitter = new NativeEventEmitter(NativeModules.AlaznahCallingPip);
    const sub = emitter.addListener(
      'AlaznahCallingPipModeChanged',
      (payload: { active?: boolean }) => {
        setIsInPictureInPicture(Boolean(payload?.active));
      },
    );

    return () => {
      sub.remove();
      if (ownAndroidArming) {
        void native.setEnabled(false).catch(() => undefined);
      }
      setIsInPictureInPicture(false);
    };
  }, [options.enabled, ownAndroidArming]);

  useEffect(() => {
    if (!options.enabled || Platform.OS !== 'android') return undefined;
    refreshAndroidSourceHint();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled) {
      setIsInPictureInPicture(false);
    }
  }, [options.enabled]);

  return {
    supported,
    isInPictureInPicture,
    refreshAndroidSourceHint,
    enter: async () => {
      if (!enabledRef.current) return false;

      if (Platform.OS === 'ios') {
        if (iosRef) {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            if (iosRef.current) {
              const ok = startIosWebRtcPip(iosRef);
              if (ok) {
                // Native AlaznahCallingPipModeChanged is the source of truth.
                return true;
              }
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
        // Fabric / findNodeHandle fallback — walk native view tree for RTCVideoView.
        return startIosPipViaNativeModule();
      }

      refreshAndroidSourceHint();
      const native = getPipNative();
      if (!native) return false;
      try {
        const ok = Boolean(await native.enter());
        return ok;
      } catch {
        return false;
      }
    },
  };
}
