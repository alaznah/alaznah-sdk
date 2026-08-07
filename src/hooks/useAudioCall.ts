import { useCall } from './useCall.js';

/** Convenience hook for audio-focused call UI. */
export function useAudioCall() {
  const call = useCall();
  return {
    call,
    isAudio: call?.mediaType === 'audio',
    muted: call?.muted ?? false,
    speakerOn: call?.speakerOn ?? false,
  };
}
