import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createEnvelope, type ServerToClientMessage } from '@alaznah/protocol';
import { SignalingClient } from './SocketClient.js';

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        const value = fn();
        if (value !== undefined) {
          resolve(value);
          return;
        }
      } catch {
        // retry
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timeout'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('SignalingClient integration', () => {
  let wss: WebSocketServer;
  let url: string;
  let connections = 0;
  let activeSocket: WebSocket | null = null;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const addr = wss.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    url = `ws://127.0.0.1:${addr.port}`;

    wss.on('connection', (socket) => {
      connections += 1;
      activeSocket = socket;
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; id: string; payload?: Record<string, unknown> };
        if (msg.type === 'auth') {
          socket.send(
            JSON.stringify(
              createEnvelope('auth.ok', { userId: 'alice', sessionId: `sess-${connections}` }, {
                ackOf: msg.id,
              }),
            ),
          );
          return;
        }
        if (msg.type === 'sync') {
          socket.send(JSON.stringify(createEnvelope('ack', { ok: true }, { ackOf: msg.id })));
          return;
        }
        if (msg.type === 'heartbeat') {
          socket.send(JSON.stringify(createEnvelope('heartbeat.ack', { at: Date.now() }, { ackOf: msg.id })));
        }
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('connects, authenticates, and syncs', async () => {
    const client = new SignalingClient({
      url,
      deviceId: 'dev-1',
      getAuthToken: () => 'dev:alice',
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      reconnect: false,
    });
    const authed = vi.fn();
    client.on('authenticated', authed);
    await client.connect();
    expect(authed).toHaveBeenCalledWith('alice', expect.stringMatching(/^sess-/));
    await client.sync();
    client.disconnect();
  });

  it('coalesces parallel connect() calls', async () => {
    const client = new SignalingClient({
      url,
      deviceId: 'dev-2',
      getAuthToken: () => 'dev:alice',
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      reconnect: false,
    });
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    await client.sync();
    client.disconnect();
  });

  it('reconnects after server drop and can sync again', async () => {
    const client = new SignalingClient({
      url,
      deviceId: 'dev-3',
      getAuthToken: () => 'dev:alice',
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      reconnect: true,
      maxReconnectAttempts: 3,
    });
    const authCount = vi.fn();
    client.on('authenticated', authCount);
    await client.connect();
    expect(authCount).toHaveBeenCalledTimes(1);

    activeSocket?.close(4000, 'test drop');
    activeSocket = null;

    await waitFor(() => (authCount.mock.calls.length >= 2 ? true : undefined));
    await client.sync();
    client.disconnect();
  });

  it('deduplicates server messages by id', async () => {
    const client = new SignalingClient({
      url,
      deviceId: 'dev-4',
      getAuthToken: () => 'dev:alice',
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      reconnect: false,
    });
    const messages: ServerToClientMessage[] = [];
    client.on('message', (m) => messages.push(m));
    await client.connect();

    const dup = createEnvelope('ack', { ok: true }, { id: 'fixed-dup-id' });
    client._inject(dup);
    client._inject(dup);
    expect(messages.filter((m) => m.id === 'fixed-dup-id')).toHaveLength(1);
    client.disconnect();
  });

  it('connect() recovers after reconnect attempts exhausted', async () => {
    const client = new SignalingClient({
      url,
      deviceId: 'dev-5',
      getAuthToken: () => 'dev:alice',
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      reconnect: true,
      maxReconnectAttempts: 0,
    });
    const exhausted = vi.fn();
    client.on('reconnectExhausted', exhausted);
    await client.connect();
    expect(client.isConnected()).toBe(true);

    activeSocket?.close(4000, 'test drop');
    activeSocket = null;
    await waitFor(() => (exhausted.mock.calls.length >= 1 ? true : undefined));

    await client.connect();
    await client.sync();
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });
});
