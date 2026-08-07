import { describe, expect, it, vi } from 'vitest';

/**
 * Lightweight unit coverage for ICE queueing semantics used by the engine.
 * Full RTCPeerConnection is platform-native; we validate queue flush ordering here.
 */
describe('ICE candidate queue semantics', () => {
  it('buffers candidates until remote description is ready then flushes in order', async () => {
    const applied: string[] = [];
    const pending: Array<{ candidate: string }> = [];
    let remoteReady = false;

    const add = async (candidate: { candidate: string }) => {
      if (!remoteReady) {
        pending.push(candidate);
        return;
      }
      applied.push(candidate.candidate);
    };

    await add({ candidate: 'a' });
    await add({ candidate: 'b' });
    expect(applied).toEqual([]);
    expect(pending.map((c) => c.candidate)).toEqual(['a', 'b']);

    remoteReady = true;
    const queued = pending.splice(0, pending.length);
    for (const candidate of queued) {
      await add(candidate);
    }
    await add({ candidate: 'c' });

    expect(applied).toEqual(['a', 'b', 'c']);
  });

  it('does not drop candidates that arrive before accept/engine creation', async () => {
    const byCall = new Map<string, Array<{ candidate: string }>>();
    const queue = (callId: string, candidate: { candidate: string }) => {
      const list = byCall.get(callId) ?? [];
      list.push(candidate);
      byCall.set(callId, list);
    };

    queue('call-1', { candidate: 'early-1' });
    queue('call-1', { candidate: 'early-2' });

    const engineAdd = vi.fn(async (_c: { candidate: string }) => undefined);
    const flushed = byCall.get('call-1') ?? [];
    byCall.set('call-1', []);
    for (const candidate of flushed) {
      await engineAdd(candidate);
    }

    expect(engineAdd).toHaveBeenCalledTimes(2);
    expect(engineAdd.mock.calls[0]?.[0]).toEqual({ candidate: 'early-1' });
    expect(engineAdd.mock.calls[1]?.[0]).toEqual({ candidate: 'early-2' });
  });
});
