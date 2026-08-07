type Listener = (...args: never[]) => void;

export class EventEmitter<TEvents extends Record<string, Listener>> {
  private listeners = new Map<keyof TEvents, Set<Listener>>();

  on<K extends keyof TEvents>(event: K, listener: TEvents[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof TEvents>(event: K, listener: TEvents[K]): void {
    this.listeners.get(event)?.delete(listener as Listener);
  }

  emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as TEvents[K])(...args);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
