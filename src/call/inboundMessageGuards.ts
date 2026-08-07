import type { CallState } from '@alaznah/protocol';

/** Ignore duplicate `call.accept` when media session is already active. */
export function shouldIgnoreDuplicateAccept(state: CallState): boolean {
  return state === 'connected' || state === 'reconnecting';
}

/** Sustained audio-only ticks before pausing camera capture (not stopping). */
export const VIDEO_SUSPEND_AUDIO_ONLY_STREAK = 12;

export function shouldSuspendVideoCapture(
  audioOnlyStreak: number,
  mediaWantsVideo: boolean,
): boolean {
  return mediaWantsVideo && audioOnlyStreak >= VIDEO_SUSPEND_AUDIO_ONLY_STREAK;
}

export function shouldResumeVideoCapture(
  videoEnabled: boolean,
  videoCaptureSuspended: boolean,
): boolean {
  return videoEnabled && videoCaptureSuspended;
}
