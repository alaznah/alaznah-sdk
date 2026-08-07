import { PermissionsAndroid, Platform } from 'react-native';

export type MediaPermissionResult = {
  microphone: boolean;
  camera: boolean;
  bluetooth: boolean;
};

/**
 * Request runtime media permissions before getUserMedia.
 * Returns granted flags; callers should fail clearly when mic is denied.
 */
export async function requestCallPermissions(
  mediaType: 'audio' | 'video',
): Promise<MediaPermissionResult> {
  if (Platform.OS !== 'android') {
    // iOS prompts via getUserMedia / Info.plist usage strings.
    return { microphone: true, camera: mediaType === 'video', bluetooth: true };
  }

  const micPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  const camPerm = PermissionsAndroid.PERMISSIONS.CAMERA;
  const btPerm =
    Platform.Version >= 31 ? PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT : null;

  // Fast path: skip the system dialog round-trip when already granted
  // (common on kill-state Accept after the user has used the app once).
  const micOk = await PermissionsAndroid.check(micPerm);
  const camOk =
    mediaType === 'audio' ? true : await PermissionsAndroid.check(camPerm);
  const btOk = btPerm ? await PermissionsAndroid.check(btPerm) : true;
  if (micOk && camOk && btOk) {
    return { microphone: true, camera: camOk, bluetooth: btOk };
  }

  const needed: string[] = [micPerm];
  if (mediaType === 'video') needed.push(camPerm);
  if (btPerm) needed.push(btPerm);

  const result = await PermissionsAndroid.requestMultiple(needed as never);
  const granted = (key: string) =>
    result[key as keyof typeof result] === PermissionsAndroid.RESULTS.GRANTED;

  return {
    microphone: granted(micPerm),
    camera: mediaType === 'audio' ? true : granted(camPerm),
    bluetooth: btPerm ? granted(btPerm) : true,
  };
}
