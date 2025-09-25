// biscuit.d.ts
type Fetcher<T> = () => Promise<T>;
type Mutator<T> = (current: T) => T | Promise<T>;

interface BiscuitEntry<T> {
    value: T;
    expiry: number;
    ttl?: number;
    fetcherId?: string; // optional ID for rebinding fetchers
    salt?: string; // optional per-entry salt if encryption enabled
}

interface GetOptions {
    /** Extend TTL on access (default: true) */
    extend?: boolean;
    /** Return stale value if expired and revalidate in background */
    staleWhileRevalidate?: boolean;
}

interface BiscuitConfig {
    /** Unique namespace → creates a separate IndexedDB per namespace */
    namespace?: string;

    /** Max items in memory (LRU eviction if exceeded) */
    maxSize?: number;

    /** Warn/purge when IndexedDB quota is close to limit */
    quotaWarningThreshold?: number; // e.g. 0.9 = 90%

    /** Optional secret key for AES-GCM encryption */
    secret?: string;

    /** Callback to handle missing fetchers after init */
    onMissingFetchers?: (ids: string[]) => void | Promise<void>;
}

interface BiscuitAPI {
    /**
     * Waits for Biscuit's internal IndexedDB to finish loading.
     * Try calling before using `.get()` or `.set()` on first page load.
     */
    ready(): Promise<void>;

    /**
     * Store a value in Biscuit
     * @param key Unique identifier
     * @param value Data to cache
     * @param ttl Time-to-live in ms (default: 5 minutes)
     * @param fetcher Optional async fetcher for background refresh
     * @param fetcherId Optional ID for later rebinding
     */
    set<T>(
        key: string,
        value: T,
        ttl?: number,
        fetcher?: Fetcher<T>,
        fetcherId?: string
    ): Promise<void>;

    /**
     * Get a value from Biscuit
     * @param key Cache key
     * @param options Extend TTL or return stale value while revalidating
     */
    get<T>(key: string, options?: GetOptions): Promise<T | null>;

    /**
     * Mutate a cached value using a mutator functions
     */
    mutate<T>(key: string, mutator: Mutator<T>): Promise<void>;

    /** Remove a specific key from Biscuit */
    remove(key: string): Promise<void>;

    /** Clear the entire Biscuit store */
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

    /** Force-refresh a specific key (ignores TTL) */
    refresh(key: string): Promise<void>;

    /** Check if a key exists and is still fresh (without extending TTL) */
    has(key: string): boolean;

    /** Get all keys currently in Biscuit */
    keys(): string[];

    /** Number of keys currently stored in memory */
    size(): number;

    /** Enable debug logging to the console */
    enableDebug(): void;

    /** Disable debug logging */
    disableDebug(): void;

    /** Returns true if the browser is online */
    isOnline(): boolean;
}

interface BiscuitFactory {
    /**
     * Create a new Biscuit instance with its own namespace
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
    BiscuitEntry,
    Fetcher,
    Mutator,
    BiscuitConfig
};
