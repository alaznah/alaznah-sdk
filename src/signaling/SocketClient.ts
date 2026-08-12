import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  createEnvelope,
  parseSignalingMessage,
  type ClientToServerMessage,
  type ServerToClientMessage,
  type SignalingMessage,
} from '@alaznah/protocol';
import { EventEmitter } from '../utils/EventEmitter.js';

export type SignalingClientEvents = {
  open: () => void;
  close: (code: number, reason: string) => void;
  message: (message: ServerToClientMessage) => void;
  error: (error: Error) => void;
  authenticated: (userId: string, sessionId: string) => void;
  /** Fired when auto-reconnect gives up — active calls must end on both sides. */
  reconnectExhausted: () => void;
};

export type SignalingClientOptions = {
  url: string;
  getAuthToken: () => Promise<string> | string;
  deviceId: string;
  WebSocketImpl?: typeof WebSocket;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastAckAt = 0;
  private closedByUser = false;
  private reconnectAttempt = 0;
  /** True after max auto-reconnect attempts — waits for explicit connect() / network restore. */
  private reconnectGaveUp = false;
  /** Bumped to cancel in-flight delayed reconnects when connect() is called explicitly. */
  private reconnectGeneration = 0;
  private authenticated = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectInFlight: Promise<void> | null = null;
  /** Suppress auto-reconnect when we intentionally close the old socket. */
  private replacingSocket = false;
  /**
   * Active call in background / PiP — JS timers are throttled; do not kill the
   * socket on short heartbeat gaps, and keep retrying reconnect forever.
   */
  private backgroundCallMode = false;
  private readonly seenIds = new Set<string>();
  private readonly emitter = new EventEmitter<SignalingClientEvents>();
  private readonly options: SignalingClientOptions;

  constructor(options: SignalingClientOptions) {
    this.options = {
      reconnect: true,
      // ~1+2+4+8+15+15 ≈ 45s — aligns with server heartbeat + disconnect grace.
      maxReconnectAttempts: 6,
      ...options,
    };
  }

  on<K extends keyof SignalingClientEvents>(event: K, listener: SignalingClientEvents[K]): () => void {
    return this.emitter.on(event, listener);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      return;
    }
    // Explicit connect (cold start / foreground / network restore) gets a fresh budget
    // even after auto-reconnect previously exhausted.
    this.reconnectAttempt = 0;
    this.reconnectGaveUp = false;
    this.reconnectGeneration += 1;
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /** Whether the client is authenticated on an open socket. */
  isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated);
  }

  /**
   * Call while a media call is backgrounded / in system PiP so heartbeat
   * timeouts and reconnect exhaustion do not tear down the call.
   */
  setBackgroundCallMode(enabled: boolean): void {
    this.backgroundCallMode = enabled;
    if (enabled) {
      this.lastAckAt = Date.now();
      this.reconnectGaveUp = false;
      this.reconnectAttempt = 0;
    }
  }

  /** Allow another auto-reconnect cycle after exhaustion (active call keep-alive). */
  resetReconnectBudget(): void {
    this.reconnectGaveUp = false;
    this.reconnectAttempt = 0;
    this.reconnectGeneration += 1;
  }

  /** Re-fetch pending invites after returning from background. */
  async sync(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error('Signaling sync requires an authenticated connection');
    }
    await this.send('sync', {});
  }

  disconnect(): void {
    this.closedByUser = true;
    this.authenticated = false;
    this.reconnectGaveUp = false;
    this.reconnectAttempt = 0;
    this.reconnectGeneration += 1;
    this.connectPromise = null;
    this.stopHeartbeat();
    this.ws?.close(1000, 'client disconnect');
    this.ws = null;
  }

  async send<TType extends ClientToServerMessage['type']>(
    type: TType,
    payload: Extract<ClientToServerMessage, { type: TType }>['payload'],
    extra: {
      callId?: string;
      to?: string;
      from?: string;
      expiresAt?: number;
    } = {},
  ): Promise<string> {
    const envelope = createEnvelope(type, payload, {
      seq: ++this.seq,
      callId: extra.callId,
      to: extra.to,
      from: extra.from,
      expiresAt: extra.expiresAt,
    }) as ClientToServerMessage;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Signaling socket is not connected');
    }
    this.ws.send(JSON.stringify(envelope));
    return envelope.id;
  }

  private async openSocket(): Promise<void> {
    const WS = this.options.WebSocketImpl ?? WebSocket;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.replacingSocket = true;
      this.ws.close(4000, 'reconnecting');
      this.ws = null;
    }
    this.authenticated = false;

    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.options.url);
      this.ws = ws;

      const onError = () => {
        cleanup();
        reject(new Error('WebSocket connection failed'));
      };

      const onOpen = () => {
        cleanup();
        void this.authenticate().then(resolve).catch(reject);
      };

      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', (ev) => this.handleRawMessage(String((ev as MessageEvent).data)));
      ws.addEventListener('close', (ev) => {
        this.authenticated = false;
        this.stopHeartbeat();
        const closeEv = ev as CloseEvent;
        const intentionalReplace = this.replacingSocket;
        this.replacingSocket = false;
        this.emitter.emit('close', closeEv.code, closeEv.reason);
        if (
          !this.closedByUser &&
          !intentionalReplace &&
          this.options.reconnect
        ) {
          void this.scheduleReconnect();
        }
      });
    });
  }

  private waitForAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Signaling auth timed out'));
      }, 10_000);

      const onAuthenticated = () => {
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const offAuth = this.on('authenticated', onAuthenticated);
      const offErr = this.on('error', onError);

      const cleanup = () => {
        clearTimeout(timeout);
        offAuth();
        offErr();
      };
    });
  }

  private async authenticate(): Promise<void> {
    this.authenticated = false;
    const token = await this.options.getAuthToken();
    const authWait = this.waitForAuth();
    await this.send('auth', {
      token,
      deviceId: this.options.deviceId,
    });
    await authWait;
    this.authenticated = true;
    this.startHeartbeat();
    this.emitter.emit('open');
  }

  private handleRawMessage(raw: string): void {
    try {
      const message = parseSignalingMessage(raw) as ServerToClientMessage;
      if (this.seenIds.has(message.id)) return;
      this.seenIds.add(message.id);
      if (this.seenIds.size > 2000) {
        const first = this.seenIds.values().next().value as string | undefined;
        if (first) this.seenIds.delete(first);
      }

      if (message.type === 'auth.ok') {
        this.reconnectAttempt = 0;
        this.emitter.emit('authenticated', message.payload.userId, message.payload.sessionId);
      }
      if (message.type === 'heartbeat.ack') {
        this.lastAckAt = Date.now();
      }
      if (message.type === 'auth.error') {
        this.authenticated = false;
        this.emitter.emit('error', new Error(message.payload.message));
      }

      this.emitter.emit('message', message);
    } catch (err) {
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastAckAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const timeoutMs = this.backgroundCallMode
        ? HEARTBEAT_TIMEOUT_MS * 6
        : HEARTBEAT_TIMEOUT_MS;
      if (Date.now() - this.lastAckAt > timeoutMs) {
        this.ws?.close(4000, 'heartbeat timeout');
        return;
      }
      void this.send('heartbeat', { sentAt: Date.now() }).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectGaveUp || this.closedByUser) {
      return;
    }
    if (this.reconnectInFlight) {
      return this.reconnectInFlight;
    }
    const max = this.backgroundCallMode
      ? Number.POSITIVE_INFINITY
      : (this.options.maxReconnectAttempts ?? 6);
    if (this.reconnectAttempt >= max) {
      if (!this.reconnectGaveUp) {
        this.reconnectGaveUp = true;
        this.emitter.emit('reconnectExhausted');
        this.emitter.emit('error', new Error('Signaling reconnect attempts exhausted'));
      }
      return;
    }
    const generation = this.reconnectGeneration;
    this.reconnectInFlight = (async () => {
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15_000);
      this.reconnectAttempt += 1;
      await new Promise((r) => setTimeout(r, delay));
      if (this.closedByUser || generation !== this.reconnectGeneration) return;
      try {
        await this.openSocket();
      } catch (err) {
        if (generation !== this.reconnectGeneration || this.closedByUser) return;
        this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.reconnectInFlight = null;
        void this.scheduleReconnect();
      }
    })().finally(() => {
      this.reconnectInFlight = null;
    });
    return this.reconnectInFlight;
  }

  /** Test helper */
  _inject(message: SignalingMessage): void {
    this.handleRawMessage(JSON.stringify(message));
  }
}
