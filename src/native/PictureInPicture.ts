import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  AppState,
  findNodeHandle,
  NativeEventEmitter,
  NativeModules,
  Platform,
  UIManager,
  type View,
} from 'react-native';

type PipNative = {
  setEnabled: (enabled: boolean) => Promise<boolean>;
  enter: () => Promise<boolean>;
  isSupported: () => Promise<boolean>;
  isActive?: () => Promise<boolean>;
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
    const node = findNodeHandle(ref.current as never);
    if (node == null) return false;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webrtc = require('react-native-webrtc') as {
      startIOSPIP?: (ref: RefObject<unknown>) => void;
    };
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

/**
 * Arm / disarm Android Activity PiP from a stable parent (CallingUI).
 * Must NOT live in ActiveCallScreen — Modal↔Activity presentation remounts
 * would call setEnabled(false) mid-enter and abort/crash PiP.
 */
export function useAndroidPipArming(enabled: boolean): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const native = getPipNative();
    if (!native) return undefined;
    void native.setEnabled(enabled).catch(() => undefined);
    return () => {
      void native.setEnabled(false).catch(() => undefined);
    };
  }, [enabled]);
}

/**
 * Picture-in-Picture for an active video call.
 *
 * Android: observes Activity PiP mode + sourceRect updates.
 *          Arming is via [useAndroidPipArming] on CallingUI.
 * iOS: react-native-webrtc AVKit path (unchanged).
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
      return undefined;
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
      return undefined;
    }
    if (Platform.OS !== 'ios') return undefined;

    // Track iOS PiP for remote objectFit contain. Do NOT call stopIOSPIP on
    // foreground — that races RN-WebRTC stopAutomatically and blinks video.
    const sub = AppState.addEventListener('change', (next) => {
      if (!enabledRef.current) return;
      if (next === 'background' || next === 'inactive') {
        setIsInPictureInPicture(true);
        return;
      }
      if (next === 'active') {
        setIsInPictureInPicture(false);
      }
    });
    return () => sub.remove();
  }, [options.enabled]);

  return {
    supported,
    isInPictureInPicture,
    refreshAndroidSourceHint,
    enter: async () => {
      if (!enabledRef.current) return false;

      if (Platform.OS === 'ios') {
        if (!iosRef) return false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (iosRef.current) {
            const ok = startIosWebRtcPip(iosRef);
            if (ok) {
              setIsInPictureInPicture(true);
              return true;
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        return false;
      }

      refreshAndroidSourceHint();
      const native = getPipNative();
      if (!native) return false;
      try {
        const ok = Boolean(await native.enter());
        if (ok) setIsInPictureInPicture(true);
        return ok;
      } catch {
        return false;
      }
    },
  };
}
