type Fetcher<T> = () => Promise<T>;
type Mutator<T> = (current: T) => T;

interface BiscuitEntry<T> {
    value: T;
    expiry: number;
    ttl?: number;
}

interface BiscuitAPI {
    set<T>(key: string, value: T, ttl?: number, fetcher?: Fetcher<T>): Promise<void>;
    get<T>(key: string, options?: { extend?: boolean }): T | null;
    mutate<T>(key: string, mutator: Mutator<T>): Promise<void>;
    remove(key: string): Promise<void>;
    clear(): Promise<void>;
    subscribe(fn: (state: Record<string, any>) => void): () => void;
}

declare const Biscuit: BiscuitAPI;

export default Biscuit;
