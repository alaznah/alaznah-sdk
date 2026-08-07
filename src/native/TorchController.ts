import { NativeModules, Platform } from 'react-native';
import { NativeAlaznahCalling } from './NativeAlaznahCalling.js';

type TorchNative = {
  hasCameraTorch?: (facingMode: string) => Promise<boolean>;
  setCameraTorch?: (enabled: boolean, facingMode: string) => Promise<boolean>;
};

function loadTorchNative(): TorchNative | null {
  const fromSpec = NativeAlaznahCalling as TorchNative | null;
  if (fromSpec?.hasCameraTorch && fromSpec?.setCameraTorch) {
    return fromSpec;
  }
  const mod = NativeModules.AlaznahCalling as TorchNative | undefined;
  if (mod?.hasCameraTorch && mod?.setCameraTorch) {
    return mod;
  }
  return null;
}

/**
 * Camera torch / flash for the active facing mode.
 * Front (`user`) and back (`environment`) are checked independently —
 * button only shows when that camera reports a torch LED.
 */
export class TorchController {
  private native = loadTorchNative();

  async hasTorch(facingMode: 'user' | 'environment'): Promise<boolean> {
    if (!this.native?.hasCameraTorch) return false;
    try {
      return Boolean(await this.native.hasCameraTorch(facingMode));
    } catch {
      return false;
    }
  }

  async setTorch(
    enabled: boolean,
    facingMode: 'user' | 'environment',
  ): Promise<boolean> {
    if (!this.native?.setCameraTorch) {
      throw new Error('Torch is not supported on this device');
    }
    try {
      return Boolean(await this.native.setCameraTorch(enabled, facingMode));
    } catch (err) {
      // Android: setTorchMode can fail while WebRTC holds the camera — surface clearly.
      if (Platform.OS === 'android' && __DEV__) {
        console.warn('[Torch] setCameraTorch failed', err);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
