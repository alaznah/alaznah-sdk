/**
 * Default hosted signaling endpoint when `CallingClientConfig.signalingUrl` is omitted.
 *
 * Override at build time with `ALAZNAH_DEFAULT_SIGNALING_URL`.
 */
const PLACEHOLDER_HOSTED_SIGNALING_URL = 'wss://signal.alaznah.com';

function readBuildTimeDefault(): string {
  try {
    const fromEnv =
      typeof process !== 'undefined'
        ? process.env?.ALAZNAH_DEFAULT_SIGNALING_URL?.trim()
        : undefined;
    if (fromEnv) return fromEnv;
  } catch {
    // React Native may not expose process.env without a babel plugin.
  }
  return PLACEHOLDER_HOSTED_SIGNALING_URL;
}

export const DEFAULT_HOSTED_SIGNALING_URL = readBuildTimeDefault();

/** Prefer explicit self-host URL; otherwise hosted default. */
export function resolveSignalingUrl(signalingUrl?: string): string {
  const explicit = signalingUrl?.trim();
  if (explicit) return explicit;
  return DEFAULT_HOSTED_SIGNALING_URL;
}
