// biscuit.d.ts
// A fetcher may optionally accept an AbortSignal to support real
// cancellation on fetchTimeout / destroy() — e.g. `fetch(url, { signal })`.
// Existing zero-arg fetchers remain valid; Biscuit just won't be able to
// truly cancel their underlying work (it will still stop *waiting* on
// them once fetchTimeout elapses).
type Fetcher<T> = (signal?: AbortSignal) => Promise<T>;
type Mutator<T> = (current: T) => T | Promise<T>;

/** A fetcher that also carries a stable ID, so it can be rebound after a
 * page reload (functions can't be persisted to IndexedDB, but the ID can). */
interface PersistableFetcher<T> {
    id: string;
    fn: Fetcher<T>;
}

/** How a key's background refresh behaves once it's due to expire. */
type RefreshPolicy =
    /** Automatically refresh in the background as the TTL nears expiry (default). */
    | "background"
    /** Never proactively scheduled — only fetches when the key is accessed
     * after expiry. Still non-blocking: get() returns the stale value
     * immediately and refreshes in the background, unless the caller
     * passes `{ blocking: true }`. */
    | "on-demand"
    /** Never auto-refresh; only `refresh()` called explicitly will update it. */
    | "never";

interface BiscuitEntry<T> {
    value: T;
    expiry: number;
    ttl?: number;
    fetcherId?: string; // optional ID for rebinding fetchers
    refreshPolicy?: RefreshPolicy;
}

interface GetOptions {
    /** Extend TTL on access (default: true) */
    extend?: boolean;
    /** If expired, return the stale value immediately and revalidate in the
     * background instead of blocking. Always the behavior for "on-demand"
     * keys regardless of this flag — this only matters for "background"
     * keys that happened to fully expire (e.g. after being offline). */
    staleWhileRevalidate?: boolean;
    /** Force get() to wait for a fresh value before resolving, when the key
     * is expired and has a fetcher. Use sparingly — this blocks the caller
     * on a network round trip; only reach for it on correctness-critical
     * reads (e.g. re-checking a permission right before a sensitive action).
     * Default: false. */
    blocking?: boolean;
}

interface SetOptions {
    /** Refresh strategy for this key (default: "background") */
    refreshPolicy?: RefreshPolicy;
}

interface WaitForOptions {
    /** Reject if the key doesn't receive a value within this many ms */
    timeout?: number;
}

interface UsageEstimate {
    usage: number;
    quota: number;
    /** usage / quota, in the range [0, 1] */
    percent: number;
}

interface SetManyItem<T = any> {
    key: string;
    value: T;
    ttl?: number;
    fetcher?: Fetcher<T> | PersistableFetcher<T>;
    options?: SetOptions;
}

interface BiscuitConfig {
    /** Unique namespace → creates a separate IndexedDB per namespace */
    namespace?: string;

    /** Max items in memory (LRU eviction if exceeded) */
    maxSize?: number;

    /** How often the garbage collector sweeps expired entries (default: 1 hour) */
    gcInterval?: number;

    /** Time to retain expired items (default: 24 hours) */
    expiredRetention?: number; // eg. 86400000 = 24 hours

    /** Warn/purge when IndexedDB quota is close to limit */
    quotaWarningThreshold?: number; // e.g. 0.9 = 90%

    /** Optional secret key for AES-GCM encryption */
    secret?: string;

    /** Enable debug logging at construction time */
    debug?: boolean;

    /** Callback to handle missing fetchers after init */
    onMissingFetchers?: (ids: string[]) => void | Promise<void>;

    /** How many times to retry a failed background refresh (default: 1) */
    maxRetries?: number;

    /** Backoff function: given the 1-based retry attempt, returns delay in ms.
     * Default: exponential, capped at 10s. */
    retryDelay?: (attempt: number) => number;

    /** Max ms to wait on a single fetcher() call before treating it as
     * failed (retries/backoff still apply on top of this). Default: no
     * timeout. Note this can't truly cancel the underlying call — it only
     * stops waiting on it, so a late resolution after timeout is discarded. */
    fetchTimeout?: number;

    /** Called for failures that Biscuit itself swallows to stay resilient
     * (persist failures, exhausted background refreshes, broadcast
     * failures, IndexedDB open failures, etc.) so they can be piped into
     * production error tracking instead of only reaching the console. */
    onError?: (error: unknown, context: string) => void;
}

interface BiscuitAPI {
    /**
     * Waits for Biscuit's internal IndexedDB to finish loading.
     * Try calling before using `.get()` or `.set()` on first page load.
     * In environments without IndexedDB (Node/SSR), Biscuit runs
     * memory-only and this still resolves normally.
     */
    ready(): Promise<void>;

    /**
     * Store a value in Biscuit.
     * @param key Unique identifier
     * @param value Data to cache
     * @param ttl Time-to-live in ms (default: 5 minutes)
     * @param fetcher Optional fetcher for background refresh. Pass a plain
     *   function for a session-only fetcher, or `{ id, fn }` if it should
     *   survive a page reload (rebind later via `registerFetcher`/`onMissingFetchers`).
     * @param options Per-key refresh policy, etc.
     * @throws if `key` is `"__meta__"` — that key is reserved internally.
     */
    set<T>(
        key: string,
        value: T,
        ttl?: number,
        fetcher?: Fetcher<T> | PersistableFetcher<T>,
        options?: SetOptions
    ): Promise<void>;

    /**
     * Get a value from Biscuit.
     * @param key Cache key
     * @param options Extend TTL or return stale value while revalidating
     */
    get<T>(key: string, options?: GetOptions): Promise<T | null>;

    /**
     * Mutate a cached value using a mutator function.
     */
    mutate<T>(key: string, mutator: Mutator<T>): Promise<void>;

    /** Remove a specific key from Biscuit */
    remove(key: string): Promise<void>;

    /** Clear the entire Biscuit store (propagates to other open tabs) */
    clear(): Promise<void>;

    /**
     * Subscribe to all cache updates.
     * Returns an unsubscribe function.
     */
    subscribe(fn: (state: Record<string, any>) => void): () => void;

    /** Subscribe to updates for a specific key.
     * Returns an unsubscribe function.
     */
    subscribeKey<T>(key: string, fn: (value: T | null) => void): () => void;

    /** Force-refresh a specific key (ignores TTL). Concurrent calls for the
     * same key share one in-flight fetch. Returns whether it succeeded. */
    refresh(key: string): Promise<boolean>;

    /**
     * Force a key to expire immediately, so the next `get()` — or an
     * attached fetcher — picks up a fresh value. Returns `false` if the
     * key doesn't exist.
     */
    invalidate(key: string): Promise<boolean>;

    /**
     * Invalidate every key matching a pattern. Accepts a `*`-wildcard
     * string (e.g. `"friends-*"`) or a RegExp. Returns the matched keys.
     */
    invalidatePattern(pattern: string | RegExp): Promise<string[]>;

    /** Set multiple keys in one call. */
    setMany(items: SetManyItem[]): Promise<void[]>;

    /** Get multiple keys in one call, returned as a `{ key: value }` map. */
    getMany<T = any>(keys: string[], options?: GetOptions): Promise<Record<string, T | null>>;

    /**
     * Resolve once the given key has a non-null value — immediately if it
     * already does, or the first time it's set/refreshed otherwise.
     */
    waitFor<T = any>(key: string, options?: WaitForOptions): Promise<T>;

    /** Best-effort storage usage estimate. Returns `null` where unsupported
     * (e.g. Node/SSR, or browsers without the Storage API). */
    estimateUsage(): Promise<UsageEstimate | null>;

    /** Check if a key exists and is still fresh (without extending TTL) */
    has(key: string): boolean;

    /** Get all keys currently in Biscuit */
    keys(): string[];

    /** Number of keys currently stored in memory (fresh only, by default) */
    size(options?: { includeExpired?: boolean }): number;

    /** Enable debug logging to the console */
    enableDebug(): void;

    /** Disable debug logging */
    disableDebug(): void;

    /** Returns true if the browser is online */
    isOnline(): boolean;

    /** Register a fetcher function for a given ID */
    registerFetcher<T>(id: string, fn: Fetcher<T>): void;

    /** Get a list of fetcher IDs that are missing (persisted but not registered) */
    getMissingFetcherIds(): string[];

    /** Inspect internal state (for debugging/testing) */
    inspect(): any;

    /** Permanently destroy this Biscuit instance and free resources */
    destroy(): void;
}

interface BiscuitFactory {
    /**
     * Create a new Biscuit instance with its own namespace. Falls back to
     * memory-only operation automatically in environments without
     * IndexedDB/window (Node, SSR, React Native).
     */
    (config?: BiscuitConfig): BiscuitAPI;
}

declare const Biscuit: BiscuitAPI;
declare const createBiscuit: BiscuitFactory;

export default Biscuit;
export {
    createBiscuit,
    BiscuitAPI,
    GetOptions,
    SetOptions,
    WaitForOptions,
    UsageEstimate,
    SetManyItem,
    BiscuitEntry,
    Fetcher,
    PersistableFetcher,
    Mutator,
    RefreshPolicy,
    BiscuitConfig
};
