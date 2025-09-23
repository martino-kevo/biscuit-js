// biscuit.d.ts
type Fetcher<T> = () => Promise<T>;
type Mutator<T> = (current: T) => T;

interface BiscuitEntry<T> {
    value: T;
    expiry: number;
    ttl?: number;
}

interface GetOptions {
    /** Extend TTL on access (default: true) */
    extend?: boolean;
    /** Return stale value if expired and revalidate in background */
    staleWhileRevalidate?: boolean;
}

interface BiscuitAPI {
    /**
     * Store a value in Biscuit
     * @param key Unique identifier
     * @param value Data to cache
     * @param ttl Time-to-live in ms (default: 5 minutes)
     * @param fetcher Optional async fetcher for background refresh
     */
    set<T>(key: string, value: T, ttl?: number, fetcher?: Fetcher<T>): Promise<void>;

    /**
     * Get a value from Biscuit
     * @param key Cache key
     * @param options Extend TTL or return stale value while revalidating
     */
    get<T>(key: string, options?: GetOptions): T | null;

    /**
     * Mutate a cached value using a mutator function
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

    /** Force-refresh a specific key (ignores TTL) */
    refresh(key: string): Promise<void>;

    /** Check if a key exists and is still fresh (without extending TTL) */
    has(key: string): boolean;

    /** Get all keys currently in Biscuit */
    keys(): string[];

    /** Number of keys currently stored in memory */
    size(): number;
}

interface BiscuitFactory {
    /**
     * Create a new Biscuit instance with its own namespace
     */
    (config?: { namespace?: string }): BiscuitAPI;
}

declare const Biscuit: BiscuitAPI;
declare const createBiscuit: BiscuitFactory;

export default Biscuit;
export { createBiscuit, BiscuitAPI, GetOptions, BiscuitEntry, Fetcher, Mutator };
