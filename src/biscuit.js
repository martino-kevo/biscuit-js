// Biscuit.js
// Memory-first, persistent, reactive browser cache with background refresh,
// cross-tab sync, TTL extension, stale-while-revalidate, and dev-friendly utilities.

function createBiscuit({ namespace = "" } = {}) {
  const prefix = namespace ? `-${namespace}` : ""; // Namespace support
  const DB_NAME = `biscuit-store${prefix}`; // IndexedDB database name
  const STORE_NAME = `biscuit-jar${prefix}`; // Object store name
  const CHANNEL_NAME = `biscuit${prefix}`; // BroadcastChannel name
  const STORAGE_KEY = `biscuit-sync${prefix}`; // localStorage key for fallback

  let db;

  const jar = new Map(); // In-memory cache: key -> { value, expiry, ttl }
  // ttl is time-to-live in ms, used for refreshing
  const refreshers = new Map(); // key -> async fetcher function
  // fetcher is an async function to get fresh data
  const refreshTimers = new Map(); // key -> timeout ID for scheduled refresh

  // Subscribers for reactive updates
  const subscribers = new Set();

  // Cross-tab sync using BroadcastChannel or localStorage fallback
  const channelSupported = typeof BroadcastChannel === "function";
  const channel = channelSupported ? new BroadcastChannel(CHANNEL_NAME) : null;

  function broadcastChange(key, value) {
    if (channelSupported) {
      channel.postMessage({ key, value });
    } else {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ key, value, t: Date.now() })
      );
    }
  }

  function handleRemoteUpdate(key, value) {
    const entry = jar.get(key);
    if (!entry || JSON.stringify(entry.value) !== JSON.stringify(value)) {
      jar.set(key, {
        value,
        expiry: entry?.expiry || Date.now() + 5 * 60 * 1000,
      });
      notify();
    }
  }

  if (channelSupported) {
    channel.onmessage = (e) => handleRemoteUpdate(e.data.key, e.data.value);
  } else {
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const { key, value } = JSON.parse(e.newValue);
        handleRemoteUpdate(key, value);
      }
    });
  }

  // IndexedDB setup
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e);
    });
  }

  // Load existing entries from IndexedDB on startup
  async function init() {
    db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    return new Promise((resolve) => {
      req.onsuccess = () => {
        req.result.forEach((entry) => {
          if (Date.now() < entry.expiry) {
            jar.set(entry.key, entry);
            scheduleRefresh(entry.key, entry.expiry);
          }
        });
        resolve();
      };
    });
  }

  // Ensure DB is ready before any operation
  const dbReady = init();
  async function withDB(fn) {
    await dbReady;
    return fn();
  }

  // Save entry to IndexedDB
  async function persist(key, value, expiry) {
    return withDB(async () => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        await tx.objectStore(STORE_NAME).put({ key, value, expiry });
      } catch (err) {
        console.error("Biscuit persist failed:", err);
      }
    });
  }

  // Remove entry from IndexedDB
  async function removeFromDB(key) {
    return withDB(async () => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        await tx.objectStore(STORE_NAME).delete(key);
      } catch (err) {
        console.error("Biscuit remove failed:", err);
      }
    });
  }

  // Clear all entries from IndexedDB
  async function clearDB() {
    return withDB(async () => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        await tx.objectStore(STORE_NAME).clear();
      } catch (err) {
        console.error("Biscuit clear failed:", err);
      }
    });
  }

  // Notify all subscribers of changes
  function notify() {
    subscribers.forEach((fn) => fn(getAll()));
  }

  // Get a snapshot of all current entries
  function getAll() {
    const result = {};
    for (const [key, { value }] of jar.entries()) {
      result[key] = value;
    }
    return result;
  }

  // Public API
  // Set a value with optional TTL and fetcher for background refresh
  async function set(key, value, ttl = 5 * 60 * 1000, fetcher = null) {
    await dbReady;
    const expiry = Date.now() + ttl;
    const entry = { key, value, expiry, ttl };
    jar.set(key, entry);
    await persist(key, value, expiry);
    broadcastChange(key, value);

    if (fetcher) refreshers.set(key, fetcher);
    scheduleRefresh(key, expiry);
    notify();
  }

  // Get a value, optionally extending TTL or using stale-while-revalidate
  function get(key, { extend = true, staleWhileRevalidate = false } = {}) {
    const entry = jar.get(key);
    if (!entry) return null;

    const expired = Date.now() > entry.expiry;

    if (expired) {
      if (staleWhileRevalidate && refreshers.get(key)) {
        refresh(key);
        return entry.value;
      }
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

  // Mutate a value with a mutator function
  async function mutate(key, mutator) {
    const current = get(key, { extend: false });
    if (current === null) return;
    const newValue = mutator(current);
    await set(key, newValue, jar.get(key)?.ttl, refreshers.get(key));
  }

  // Remove a value
  async function remove(key) {
    jar.delete(key);
    refreshers.delete(key);
    if (refreshTimers.has(key)) {
      clearTimeout(refreshTimers.get(key));
      refreshTimers.delete(key);
    }
    await removeFromDB(key);
    broadcastChange(key, null);
    notify();
  }

  // Clear all entries
  async function clear() {
    jar.clear();
    refreshers.clear();
    refreshTimers.forEach((t) => clearTimeout(t));
    refreshTimers.clear();
    await clearDB();
    broadcastChange(null, null);
    notify();
  }

  // Subscribe to changes, returns unsubscribe function
  function subscribe(fn) {
    subscribers.add(fn);
    fn(getAll());
    return () => subscribers.delete(fn);
  }

  // Schedule background refresh before expiry
  function scheduleRefresh(key, expiry) {
    const entry = jar.get(key);
    if (!entry) return;

    if (refreshTimers.has(key)) clearTimeout(refreshTimers.get(key));

    const ttl = entry.ttl || 5 * 60 * 1000;
    const refreshTime = expiry - Date.now() - ttl * 0.1;
    if (refreshTime <= 0) return;

    const timer = setTimeout(() => refresh(key), refreshTime);
    refreshTimers.set(key, timer);
  }

  // Refresh data using the fetcher function
  async function refresh(key) {
    const fetcher = refreshers.get(key);
    if (!fetcher) return;
    try {
      const freshValue = await fetcher();
      await set(key, freshValue, jar.get(key)?.ttl, fetcher);
    } catch (e) {
      console.warn(`Biscuit refresh failed for ${key}:`, e);
    }
  }

  // Check if a key exists and is fresh without extending TTL
  function has(key) {
    const entry = jar.get(key);
    return !!entry && Date.now() < entry.expiry;
  }

  // Get number of entries in the cache
  function size() {
    return jar.size;
  }

  // Get all keys in the cache
  function keys() {
    return Array.from(jar.keys());
  }

  // Expose for debugging in devtools
  if (typeof window !== "undefined") {
    window[`__BISCUIT__${prefix}`] = { jar, refresh, clear, keys, size, getAll };
  }

  // Return public API
  return { set, get, mutate, remove, clear, subscribe, refresh, has, keys, size };
}

const Biscuit = createBiscuit();
export default Biscuit;
export { createBiscuit };

// ✅ What’s New & Better

// refresh(key) → force refresh data (ignore TTL)

// has(key) → check if key exists and is fresh without extending TTL

// staleWhileRevalidate option → return stale data while re-fetching in background

// Timer management → clears old timers when resetting values (no memory leaks)

// Utility functions → keys(), size() for debugging & devtools

// Live DevTools Access → window.__BISCUIT__ lets devs inspect cache manually
