/**
 * Expo config plugin for development builds.
 * Adds camera/mic permissions and documents native call UI and media requirements.
 */
module.exports = function withAlaznahCalling(config) {
  if (!config.ios) config.ios = {};
  if (!config.ios.infoPlist) config.ios.infoPlist = {};
  config.ios.infoPlist.NSCameraUsageDescription =
    config.ios.infoPlist.NSCameraUsageDescription ||
    'Camera access is required for video calls.';
  config.ios.infoPlist.NSMicrophoneUsageDescription =
    config.ios.infoPlist.NSMicrophoneUsageDescription ||
    'Microphone access is required for audio and video calls.';
  config.ios.infoPlist.UIBackgroundModes = Array.from(
    new Set([
      ...(config.ios.infoPlist.UIBackgroundModes || []),
      'audio',
      'voip',
      'remote-notification',
    ]),
  );
  config.ios.entitlements = config.ios.entitlements || {};
  config.ios.entitlements['aps-environment'] =
    config.ios.entitlements['aps-environment'] || 'development';

  if (!config.android) config.android = {};
  if (!config.android.permissions) config.android.permissions = [];
  const needed = [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.FOREGROUND_SERVICE_CAMERA',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
    'android.permission.VIBRATE',
    'android.permission.USE_FULL_SCREEN_INTENT',
  ];
  config.android.permissions = Array.from(new Set([...config.android.permissions, ...needed]));

  return config;
};
