/**
 * Small TTL + LRU cache with single-flight coalescing.
 *
 * Why hand-rolled: the MCP server is a single process with predictable access
 * patterns, and this keeps the hot path allocation-free compared to a generic
 * cache library while giving us exactly two behaviours we need:
 *   1. concurrent identical reads share one upstream request;
 *   2. entries expire from the head because Map preserves insertion order.
 */
interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  size: number;
  evictions: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(maxEntries: number, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh insertion order for LRU behaviour.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      size: this.entries.size,
      evictions: this.evictions,
    };
  }

  async getOrLoad(key: string, ttlMs: number, loader: () => Promise<V>): Promise<{ value: V; cached: boolean }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, cached: true };

    const pending = this.inflight.get(key);
    if (pending) {
      this.coalesced++;
      return { value: (await pending) as V, cached: true };
    }

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return { value: await promise, cached: false };
  }
}
