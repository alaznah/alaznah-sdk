export type IceCandidateKind = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/** ICE candidate priority (higher = preferred). host/srflx before relay. */
const PRIORITY: Record<IceCandidateKind, number> = {
  host: 4,
  srflx: 3,
  prflx: 2,
  relay: 1,
  unknown: 0,
};

export function parseIceCandidateType(candidate: string): IceCandidateKind {
  const match = / typ (\w+)/i.exec(candidate);
  const raw = match?.[1]?.toLowerCase() ?? 'unknown';
  if (raw === 'host' || raw === 'srflx' || raw === 'prflx' || raw === 'relay') return raw;
  return 'unknown';
}

export function iceCandidatePriority(candidate: string): number {
  return PRIORITY[parseIceCandidateType(candidate)];
}

/**
 * P2P-first trickle policy: defer relay candidates until ICE recovery enables TURN.
 */
export function shouldTrickleLocalCandidate(
  candidate: string,
  options: { allowRelay: boolean; forceRelay?: boolean },
): boolean {
  if (options.forceRelay) return true;
  const kind = parseIceCandidateType(candidate);
  if (kind === 'relay') return options.allowRelay;
  return true;
}

export function sortIceCandidatesByPriority<T extends { candidate: string }>(
  candidates: T[],
): T[] {
  return [...candidates].sort(
    (a, b) => iceCandidatePriority(b.candidate) - iceCandidatePriority(a.candidate),
  );
}
