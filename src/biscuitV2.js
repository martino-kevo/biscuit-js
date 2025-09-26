// BiscuitV2.js
// Universal cache with adapter support (browser + server)
// import { MemoryAdapter } from './adapters/MemoryAdapter.js';
// const memoryAdapter = new MemoryAdapter();
// const biscuit = createBiscuitV2({ adapter: memoryAdapter });

// BiscuitV2.js — Adapter-agnostic, memory-first, persistent cache

class MemoryAdapter {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) || null; }
    async set(key, entry) { this.store.set(key, entry); }
    async delete(key) { this.store.delete(key); }
    async clear() { this.store.clear(); }
    async getAll() { return Array.from(this.store.entries()).map(([key, value]) => ({ key, ...value })); }
}

function createBiscuitV2({
    namespace = "",
    maxSize = null,
    maxBytes = null,
    gcInterval = 60 * 60 * 1000,
    expiredRetention = 24 * 60 * 60 * 1000,
    adapter = null,
    debug = false,
} = {}) {
    const ns = namespace ? `${namespace}:` : "";
    const jar = new Map(); // key -> { key, value, expiry, ttl, fetcherId? }
    const accessTimestamps = new Map();
    const refreshers = new Map();
    const refreshTimers = new Map();
    const subscribers = new Set();
    const keySubscribers = new Map();
    const fetcherRegistry = new Map();

    let totalBytes = 0;
    let destroyed = false;
    const debugEnabled = !!debug;
    adapter = adapter || new MemoryAdapter();

    function log(...args) { if (debugEnabled) console.log("[BISCUIT]", ...args); }
    function namespacedKey(key) { return ns + key; }
    function approximateSize(value) { try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return 0; } }

    function touchKey(key) { accessTimestamps.set(key, Date.now()); }

    async function enforceMaxSizeIfNeeded() {
        if (!maxSize || jar.size <= maxSize) return;
        const items = Array.from(accessTimestamps.entries()).sort((a, b) => a[1] - b[1]);
        while (jar.size > maxSize) {
            const [oldestKey] = items.shift();
            await remove(oldestKey);
        }
    }

    async function enforceMaxBytesIfNeeded() {
        if (!maxBytes || totalBytes <= maxBytes) return;
        const items = Array.from(accessTimestamps.entries()).sort((a, b) => a[1] - b[1]);
        while (totalBytes > maxBytes && items.length) {
            const [oldestKey] = items.shift();
            const removed = jar.get(oldestKey);
            totalBytes -= approximateSize(removed.value);
            await remove(oldestKey);
        }
    }

    async function set(key, value, ttl = 5 * 60 * 1000, fetcher = null) {
        ensureNotDestroyed();
        const entryKey = namespacedKey(key);
        const oldEntry = jar.get(key);
        const oldSize = oldEntry ? approximateSize(oldEntry.value) : 0;

        const expiry = Date.now() + ttl;
        jar.set(key, { key, value, expiry, ttl, fetcherId: fetcher?.id || null });
        totalBytes += approximateSize(value) - oldSize;
        touchKey(key);

        if (fetcher) {
            if (typeof fetcher === "function") refreshers.set(key, fetcher);
            else if (fetcher.id && typeof fetcher.fn === "function") {
                refreshers.set(key, fetcher.fn);
                fetcherRegistry.set(fetcher.id, fetcher.fn);
            }
        } else {
            refreshers.delete(key);
        }
        await adapter.set(entryKey, jar.get(key));
        await enforceMaxSizeIfNeeded();
        await enforceMaxBytesIfNeeded();
        notify(key);

        // --- schedule refresh after storing
        scheduleRefresh(key, expiry);
    }


    // --- get
    async function get(key, { extend = true, staleWhileRevalidate = false } = {}) {
        ensureNotDestroyed();
        const entry = jar.get(key);
        if (!entry) return null;
        const expired = Date.now() > entry.expiry;

        if (expired) {
            if (staleWhileRevalidate && refreshers.get(key)) refresh(key).catch(log);
            else {
                await remove(key);
                return null;
            }
        }
        if (extend) entry.expiry = Date.now() + (entry.ttl || 5 * 60 * 1000);
        return entry.value;
    }

    async function mutate(key, mutator) {
        ensureNotDestroyed();
        if (typeof mutator !== "function") throw new Error("mutate() expects a function as second argument");
        const current = await get(key, { extend: false });
        if (current === null) return;
        const newValue = await Promise.resolve(mutator(current));
        await set(key, newValue, jar.get(key)?.ttl, refreshers.get(key) ? { fn: refreshers.get(key), id: jar.get(key)?.fetcherId } : null);
    }

    async function remove(key) {
        ensureNotDestroyed();
        const entryKey = namespacedKey(key);

        jar.delete(key);
        refreshers.delete(key);
        accessTimestamps.delete(key);

        // cancel pending refresh timer
        if (refreshTimers.has(key)) {
            clearTimeout(refreshTimers.get(key));
            refreshTimers.delete(key);
        }

        refreshGenerations.delete(key);
        totalBytes -= approximateSize(jar.get(key)?.value) || 0;

        await adapter.delete(entryKey);
        notify(key);
    }

    async function clear() {
        ensureNotDestroyed();

        jar.clear();
        refreshers.clear();
        accessTimestamps.clear();

        // cancel all pending refresh timers
        for (const timer of refreshTimers.values()) clearTimeout(timer);
        refreshTimers.clear();

        refreshGenerations.clear();
        totalBytes = 0;

        await adapter.clear();
        notify();
    }

    function subscribe(fn) { subscribers.add(fn); fn(inspect()); return () => subscribers.delete(fn); }
    function subscribeKey(key, fn) {
        if (!keySubscribers.has(key)) keySubscribers.set(key, new Set());
        keySubscribers.get(key).add(fn);
        fn(jar.get(key) || null);
        return () => keySubscribers.get(key).delete(fn);
    }

    function notify(key) {
        if (key) {
            if (keySubscribers.has(key)) {
                for (const fn of keySubscribers.get(key)) {
                    try { fn(jar.get(key)?.value); } catch (e) { log("key subscriber error", e); }
                }
            }
        } else {
            const snapshot = Array.from(jar.entries()).reduce((acc, [k, v]) => (acc[k] = v.value, acc), {});
            subscribers.forEach(fn => { try { fn(snapshot); } catch (e) { log("subscriber error", e); } });
        }
    }

    function scheduleRefresh(key, expiry) {
        if (!refreshers.has(key)) return; // only schedule if a fetcher exists

        // cancel any existing timer
        if (refreshTimers.has(key)) clearTimeout(refreshTimers.get(key));

        const entry = jar.get(key);
        if (!entry) return;

        const ttl = entry.ttl || 5 * 60 * 1000;
        const refreshTime = expiry - Date.now() - Math.floor(ttl * 0.1); // ~90% TTL

        // function to actually trigger refresh with rate-limiting
        const doRefresh = async () => {
            if (!isOnline()) return; // skip if offline
            const generation = (refreshGenerations.get(key) || 0) + 1;
            refreshGenerations.set(key, generation);
            try {
                const fetcher = refreshers.get(key);
                if (!fetcher) return;
                const freshValue = await fetcher();
                // only apply if no newer refresh has occurred
                if (refreshGenerations.get(key) === generation) {
                    await set(key, freshValue, entry.ttl, { fn: fetcher, id: entry.fetcherId });
                }
            } catch (e) {
                console.warn(`[BISCUIT] Refresh failed for ${key}`, e);
                // optional retry once after short delay
                setTimeout(() => doRefresh(), 100);
            }
        };

        if (refreshTime <= 0) {
            // immediate refresh, rate-limited by setTimeout
            const timer = setTimeout(doRefresh, 50);
            refreshTimers.set(key, timer);
        } else {
            const timer = setTimeout(doRefresh, refreshTime);
            refreshTimers.set(key, timer);
        }
    }

    async function refresh(key) {
        ensureNotDestroyed();
        const fetcher = refreshers.get(key);
        if (!fetcher) return;
        try {
            const freshValue = await fetcher();
            await set(key, freshValue, jar.get(key)?.ttl, { fn: fetcher, id: jar.get(key)?.fetcherId });
        } catch (e) {
            console.warn(`[BISCUIT] Refresh failed for ${key}`, e);
            // optional: retry once
            try {
                const retryValue = await fetcher();
                await set(key, retryValue, jar.get(key)?.ttl, { fn: fetcher, id: jar.get(key)?.fetcherId });
            } catch { }
        }
    }

    // Returns an array of all keys currently in the cache
    function keys() {
        ensureNotDestroyed();
        return Array.from(jar.keys());
    }

    // Returns true if a key exists and is not expired
    function has(key) {
        ensureNotDestroyed();
        const entry = jar.get(key);
        if (!entry) return false;
        return Date.now() < entry.expiry;
    }

    // Returns the number of entries currently in the cache
    function size() {
        ensureNotDestroyed();
        return jar.size;
    }

    // --- inspection
    function inspect() {
        ensureNotDestroyed();
        return Array.from(jar.entries()).map(([k, v]) => ({
            key: k,
            value: v.value,
            expiry: v.expiry,
            ttl: v.ttl,
            fetcherId: v.fetcherId,
            bytes: approximateSize(v.value)
        }));
    }

    function ensureNotDestroyed() { if (destroyed) throw new Error("Biscuit instance destroyed"); }

    function destroy() {
        destroyed = true;
        refreshTimers.forEach(t => clearTimeout(t));
        refreshTimers.clear();
        subscribers.clear();
        keySubscribers.clear();
        refreshers.clear();
        jar.clear();
        accessTimestamps.clear();
        totalBytes = 0;
        if (adapter.close) adapter.close(); // optional for DB adapters
    }

    return {
        // public API
        set, get, remove, clear, subscribe, subscribeKey, mutate,
        refresh, keys, has, size,
        enforceMaxSizeIfNeeded, enforceMaxBytesIfNeeded,
        inspect, destroy
    };
}

export { createBiscuitV2, MemoryAdapter };



