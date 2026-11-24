import type { IceServerConfig } from '@alaznah/protocol';

export const DEFAULT_STUN_SERVERS: IceServerConfig[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export function iceServerUrls(server: IceServerConfig): string[] {
  return (Array.isArray(server.urls) ? server.urls : [server.urls]).map(String);
}

export function hasTurnServers(servers: IceServerConfig[]): boolean {
  return servers.some((server) =>
    iceServerUrls(server).some((url) => url.startsWith('turn')),
  );
}

/** STUN-only fallback when signaling has not issued TURN URLs. */
export function stunOnlyIceServers(
  servers: IceServerConfig[],
  fallback: IceServerConfig[] = DEFAULT_STUN_SERVERS,
): IceServerConfig[] {
  const out: IceServerConfig[] = [];
  for (const server of servers) {
    const urls = iceServerUrls(server).filter((url) => url.startsWith('stun:'));
    if (urls.length) out.push({ urls });
  }
  return out.length ? out : fallback;
}

/**
 * ICE list for the *first* PeerConnection.
 * Keep TURN when credentials exist (cellular / CGNAT). Host/srflx still win on LAN.
 */
export function iceServersForPeerConnection(
  servers: IceServerConfig[],
  fallback: IceServerConfig[] = DEFAULT_STUN_SERVERS,
): IceServerConfig[] {
  if (hasTurnServers(servers)) return servers;
  return stunOnlyIceServers(servers, fallback);
}
