import type { WebRtcAdapters } from './PeerConnectionEngine.js';

export function loadWebRtcAdapters(): WebRtcAdapters {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webrtc = require('react-native-webrtc');
    return {
      RTCPeerConnection: webrtc.RTCPeerConnection,
      mediaDevices: webrtc.mediaDevices,
      MediaStream: webrtc.MediaStream,
    };
  } catch {
    if (typeof globalThis !== 'undefined' && 'RTCPeerConnection' in globalThis) {
      return {
        RTCPeerConnection: globalThis.RTCPeerConnection as unknown as WebRtcAdapters['RTCPeerConnection'],
        mediaDevices: navigator.mediaDevices as WebRtcAdapters['mediaDevices'],
        MediaStream: globalThis.MediaStream as unknown as WebRtcAdapters['MediaStream'],
      };
    }
    throw new Error(
      'WebRTC adapters not found. Install react-native-webrtc or provide a browser WebRTC environment.',
    );
  }
}
