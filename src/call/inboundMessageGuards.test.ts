import { describe, expect, it } from 'vitest';
import {
  shouldIgnoreDuplicateAccept,
  shouldResumeVideoCapture,
  shouldSuspendVideoCapture,
  VIDEO_SUSPEND_AUDIO_ONLY_STREAK,
} from './inboundMessageGuards.js';

describe('inboundMessageGuards', () => {
  it('ignores duplicate accept when connected or reconnecting', () => {
    expect(shouldIgnoreDuplicateAccept('connected')).toBe(true);
    expect(shouldIgnoreDuplicateAccept('reconnecting')).toBe(true);
    expect(shouldIgnoreDuplicateAccept('accepted')).toBe(false);
    expect(shouldIgnoreDuplicateAccept('ringing')).toBe(false);
  });

  it('suspends video capture after sustained audio-only tier', () => {
    expect(shouldSuspendVideoCapture(VIDEO_SUSPEND_AUDIO_ONLY_STREAK - 1, true)).toBe(false);
    expect(shouldSuspendVideoCapture(VIDEO_SUSPEND_AUDIO_ONLY_STREAK, true)).toBe(true);
    expect(shouldSuspendVideoCapture(VIDEO_SUSPEND_AUDIO_ONLY_STREAK + 1, false)).toBe(false);
  });

  it('resumes video when tier enables video again', () => {
    expect(shouldResumeVideoCapture(true, true)).toBe(true);
    expect(shouldResumeVideoCapture(false, true)).toBe(false);
    expect(shouldResumeVideoCapture(true, false)).toBe(false);
  });
});
