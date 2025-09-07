// Biscuit.js - Memory-first, persistent, reactive browser cache with background refresh & cross-tab sync
const Biscuit = (() => {
    const DB_NAME = "biscuit-store";
    const STORE_NAME = "biscuit-jar";
    let db;
    const jar = new Map();
    const subscribers = new Set();
    const refreshers = new Map();

    // --- Cross-tab sync ---
    const channelSupported = typeof BroadcastChannel === "function";
    const channel = channelSupported ? new BroadcastChannel("biscuit") : null;

    function broadcastChange(key, value) {
        if (channelSupported) {
            channel.postMessage({ key, value });
        } else {
            localStorage.setItem("biscuit-sync", JSON.stringify({ key, value, t: Date.now() }));
        }
    }

    function handleRemoteUpdate(key, value) {
        const entry = jar.get(key);
        if (!entry || JSON.stringify(entry.value) !== JSON.stringify(value)) {
            jar.set(key, { value, expiry: entry?.expiry || Date.now() + 5 * 60 * 1000 });
            subscribers.forEach(fn => fn(getAll()));
        }
    }

    if (channelSupported) {
        channel.onmessage = e => handleRemoteUpdate(e.data.key, e.data.value);
    } else {
        window.addEventListener("storage", e => {
            if (e.key === "biscuit-sync" && e.newValue) {
                const { key, value } = JSON.parse(e.newValue);
                handleRemoteUpdate(key, value);
            }
        });
    }

    // --- IndexedDB Setup ---
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "key" });
                }
            };
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e);
        });
    }

    async function init() {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        return new Promise(resolve => {
            req.onsuccess = () => {
                req.result.forEach(entry => {
                    if (Date.now() < entry.expiry) {
                        jar.set(entry.key, entry);
                        scheduleRefresh(entry.key, entry.expiry);
                    }
                });
                resolve();
            };
        });
    }

    async function persist(key, value, expiry) {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        await store.put({ key, value, expiry });
    }

    async function removeFromDB(key) {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        await store.delete(key);
    }

    async function clearDB() {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        await store.clear();
    }

    function notify() {
        subscribers.forEach(fn => fn(getAll()));
    }

    function getAll() {
        const result = {};
        for (const [key, { value }] of jar.entries()) {
            result[key] = value;
        }
        return result;
    }

    // --- Core API ---
    async function set(key, value, ttl = 5 * 60 * 1000, fetcher = null) {
        const expiry = Date.now() + ttl;
        const entry = { key, value, expiry, ttl };
        jar.set(key, entry);
        await persist(key, value, expiry);
        broadcastChange(key, value);

        if (fetcher) refreshers.set(key, fetcher);
        scheduleRefresh(key, expiry);
        notify();
    }

    function get(key, { extend = true } = {}) {
        const entry = jar.get(key);
        if (!entry) return null;

        if (Date.now() > entry.expiry) {
            jar.delete(key);
            removeFromDB(key);
            broadcastChange(key, null);
            notify();
            return null;
        }

        if (extend) {
            entry.expiry = Date.now() + (entry.ttl || 5 * 60 * 1000);
            persist(key, entry.value, entry.expiry);
            scheduleRefresh(key, entry.expiry);
        }

        return entry.value;
    }

    async function mutate(key, mutator) {
        const current = get(key);
        if (current === null) return;
        const newValue = mutator(current);
        await set(key, newValue, jar.get(key)?.ttl, refreshers.get(key));
    }

    async function remove(key) {
        jar.delete(key);
        refreshers.delete(key);
        await removeFromDB(key);
        broadcastChange(key, null);
        notify();
    }

    async function clear() {
        jar.clear();
        refreshers.clear();
        await clearDB();
        broadcastChange(null, null);
        notify();
    }

    function subscribe(fn) {
        subscribers.add(fn);
        fn(getAll());
        return () => subscribers.delete(fn);
    }

    // --- Background Refresh ---
    function scheduleRefresh(key, expiry) {
        const entry = jar.get(key);
        if (!entry) return;

        const refreshTime = expiry - Date.now() - entry.ttl * 0.1;
        if (refreshTime <= 0) return;

        setTimeout(async () => {
            const fetcher = refreshers.get(key);
            if (fetcher) {
                try {
                    const freshValue = await fetcher();
                    await set(key, freshValue, entry.ttl, fetcher);
                } catch (e) {
                    console.warn(`Biscuit refresh failed for ${key}:`, e);
                }
            }
        }, refreshTime);
    }

    init();

    return { set, get, mutate, remove, clear, subscribe };
})();

export default Biscuit;
