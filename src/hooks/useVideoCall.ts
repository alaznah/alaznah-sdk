import { useCall } from './useCall.js';

/** Convenience hook for video-focused call UI. */
export function useVideoCall() {
  const call = useCall();
  return {
    call,
    isVideo: call?.mediaType === 'video',
    videoEnabled: call?.videoEnabled ?? false,
    localStream: call?.localStream ?? null,
    remoteStream: call?.remoteStream ?? null,
  };
}
