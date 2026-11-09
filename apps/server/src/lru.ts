/**
 * Small bounded LRU with TTL and an optional byte budget (docs/adr/0753-*).
 * Map insertion order is the recency order: get() re-inserts, eviction drops the first key.
 * Single-process cache — every user must key it with a revision so stale entries are never served.
 */
export class BoundedLru<V> {
  private readonly map = new Map<string, { value: V; expires: number; bytes: number }>()
  private bytes = 0

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (v: V) => number = () => 0,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expires <= Date.now()) {
      this.drop(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: V): void {
    const bytes = this.sizeOf(value)
    if (bytes > this.maxBytes) return
    this.drop(key)
    this.map.set(key, { value, expires: Date.now() + this.ttlMs, bytes })
    this.bytes += bytes
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
  }

  /** The value without touching recency or expiry (listings, diagnostics); undefined when expired. */
  peek(key: string): V | undefined {
    const e = this.map.get(key)
    return e && e.expires > Date.now() ? e.value : undefined
  }

  /** Keys from least to most recently used (expired entries included until they are touched). */
  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  /** Removes every entry whose key starts with `prefix` (explicit invalidation). */
  deletePrefix(prefix: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.drop(k)
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.map.size
  }

  get byteSize(): number {
    return this.bytes
  }

  private drop(key: string): void {
    const e = this.map.get(key)
    if (!e) return
    this.bytes -= e.bytes
    this.map.delete(key)
  }
}
