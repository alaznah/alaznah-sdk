/**
 * react-native-webrtc calls `debug.enable('rn-webrtc:*')` on import, which prints
 * `rn-webrtc:pc:DEBUG` lines to the console. Silence that in release builds;
 * keep verbose WebRTC logs in Metro __DEV__ only.
 */
let silenced = false;

export function silenceWebRtcDebugLogs(): void {
  if (__DEV__ || silenced) return;
  silenced = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const debug = require('debug') as { enable: (namespaces: string) => void };
    debug.enable('-rn-webrtc:*');
  } catch {
    // `debug` is a transitive dep of react-native-webrtc — ignore if unavailable.
  }
}
