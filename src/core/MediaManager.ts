import { AudioSessionController } from '../native/AudioSessionController.js';
import { requestCallPermissions } from '../native/MediaPermissions.js';
import type { CallMediaType } from '../types/index.js';

/**
 * Media acquisition / audio-session façade used by CallManager.
 * Keeps mic/camera permission + speaker routing in one place.
 */
export class MediaManager {
  private readonly audio = new AudioSessionController();

  async ensurePermissions(mediaType: CallMediaType) {
    return requestCallPermissions(mediaType);
  }

  prepareForWebRtc(mediaType: CallMediaType) {
    this.audio.prepareForWebRtc(mediaType);
  }

  setSpeaker(enabled: boolean) {
    this.audio.setSpeaker(enabled);
  }

  stop() {
    this.audio.stop();
  }
}
