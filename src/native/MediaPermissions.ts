import { PermissionsAndroid, Platform } from 'react-native';

export type MediaPermissionResult = {
  microphone: boolean;
  camera: boolean;
  bluetooth: boolean;
};

/** Runtime permission mode for calling. */
export type CallPermissionMode = 'audio' | 'video';

/**
 * Request runtime media permissions before getUserMedia.
 * Returns granted flags; callers should fail clearly when mic is denied.
 *
 * - `'audio'` — microphone (+ Bluetooth on Android 12+)
 * - `'video'` — microphone + camera (+ Bluetooth)
 *
 * If the app offers voice and video, call `'audio'` or `'video'` for the
 * upcoming call (or `'video'` once at startup to cover both).
 */
export async function requestCallPermissions(
  mode: CallPermissionMode,
): Promise<MediaPermissionResult> {
  const wantCamera = mode === 'video';

  if (Platform.OS !== 'android') {
    // iOS prompts via getUserMedia / Info.plist usage strings.
    return { microphone: true, camera: wantCamera, bluetooth: true };
  }

  const micPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  const camPerm = PermissionsAndroid.PERMISSIONS.CAMERA;
  const btPerm =
    Platform.Version >= 31 ? PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT : null;

  // Fast path: skip the system dialog round-trip when already granted
  // (common on kill-state Accept after the user has used the app once).
  const micOk = await PermissionsAndroid.check(micPerm);
  const camOk = wantCamera ? await PermissionsAndroid.check(camPerm) : true;
  const btOk = btPerm ? await PermissionsAndroid.check(btPerm) : true;
  if (micOk && camOk && btOk) {
    return { microphone: true, camera: wantCamera ? camOk : true, bluetooth: btOk };
  }

  const needed: string[] = [micPerm];
  if (wantCamera) needed.push(camPerm);
  if (btPerm) needed.push(btPerm);

  const result = await PermissionsAndroid.requestMultiple(needed as never);
  const granted = (key: string) =>
    result[key as keyof typeof result] === PermissionsAndroid.RESULTS.GRANTED;

  return {
    microphone: granted(micPerm),
    camera: wantCamera ? granted(camPerm) : true,
    bluetooth: btPerm ? granted(btPerm) : true,
  };
}
