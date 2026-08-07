import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  AppState,
  findNodeHandle,
  NativeEventEmitter,
  NativeModules,
  Platform,
  UIManager,
} from 'react-native';

type PipNative = {
  setEnabled: (enabled: boolean) => Promise<boolean>;
  enter: () => Promise<boolean>;
  isSupported: () => Promise<boolean>;
  isActive?: () => Promise<boolean>;
};

function getPipNative(): PipNative | null {
  const mod = NativeModules.AlaznahCallingPip as PipNative | undefined;
  if (!mod?.setEnabled || !mod?.enter) return null;
  return mod;
}

function startIosWebRtcPip(ref: RefObject<unknown>): boolean {
  try {
    const node = findNodeHandle(ref.current as never);
    if (node == null) return false;

    // Prefer the library helper when present.
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
 * Enables system Picture-in-Picture for an active video call.
 * - Android: OS activity PiP via AlaznahCallingPip + MainActivity.
 * - iOS: react-native-webrtc `iosPIP` on the remote RTCView (auto + manual).
 *
 * Do NOT manually call stopIOSPIP on foreground — that races RN-WebRTC's
 * stopAutomatically and causes a video blink when returning from PiP.
 */
export function useCallPictureInPicture(options: {
  enabled: boolean;
  /** Ref to the remote RTCView that has `iosPIP` enabled. */
  iosRemoteVideoRef?: RefObject<unknown>;
}): {
  supported: boolean;
  isInPictureInPicture: boolean;
  enter: () => Promise<boolean>;
} {
  const [supported, setSupported] = useState(Platform.OS === 'android' || Platform.OS === 'ios');
  const [isInPictureInPicture, setIsInPictureInPicture] = useState(false);
  const enabledRef = useRef(options.enabled);
  enabledRef.current = options.enabled;
  const iosRef = options.iosRemoteVideoRef;

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
    void native.setEnabled(options.enabled).catch(() => undefined);

    const emitter = new NativeEventEmitter(NativeModules.AlaznahCallingPip);
    const sub = emitter.addListener('AlaznahCallingPipModeChanged', (payload: { active?: boolean }) => {
      setIsInPictureInPicture(Boolean(payload?.active));
    });

    return () => {
      sub.remove();
      void native.setEnabled(false).catch(() => undefined);
    };
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled) {
      setIsInPictureInPicture(false);
      return undefined;
    }

    const sub = AppState.addEventListener('change', (next) => {
      if (!enabledRef.current) return;

      if (next === 'background') {
        if (Platform.OS === 'android') {
          const native = getPipNative();
          void native?.enter().catch(() => undefined);
          setIsInPictureInPicture(true);
        } else if (Platform.OS === 'ios') {
          // Automatic PiP from iosPIP.startAutomatically — just track state.
          setIsInPictureInPicture(true);
        }
        return;
      }

      if (next === 'active') {
        // Let RN-WebRTC stopAutomatically restore inline video — no manual stopIOSPIP.
        setIsInPictureInPicture(false);
      }
    });

    return () => sub.remove();
  }, [options.enabled]);

  return {
    supported,
    isInPictureInPicture,
    enter: async () => {
      if (!enabledRef.current) return false;
      if (Platform.OS === 'ios') {
        if (!iosRef) return false;
        // Ref / PiP possibility can lag one frame after mount — retry briefly.
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
