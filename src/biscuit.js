// Biscuit.js
// Memory-first, persistent, reactive browser cache with background refresh,
// cross-tab sync, TTL extension, stale-while-revalidate, and dev-friendly utilities.

// Biscuit.js (extended)
// Memory-first, persistent, reactive browser cache with:
// background refresh, cross-tab sync, TTL extension, stale-while-revalidate,
// garbage collection, LRU eviction, offline support, optional AES-GCM encryption,
// and IndexedDB quota checks.

// Biscuit.js (extended with salt-per-db, fetcherId persistence, namespace-separated DBs)
// Usage: createBiscuit({ namespace, secret, maxSize, gcInterval, quotaWarningThreshold, debug })

// Biscuit.js — patched with onMissingFetchers callback & 24hr auto-GC
// Usage: createBiscuit({ namespace, secret, onMissingFetchers, ... })

function createBiscuit({
  namespace = "",
  maxSize = null,
  gcInterval = 60 * 60 * 1000, // default GC every hour
  expiredRetention = 24 * 60 * 60 * 1000, // keep expired entries for 24 hours before GC removal
  quotaWarningThreshold = 0.9,
  secret = null,
  debug = false,
  onMissingFetchers = null, // optional callback: async (missingIds:Array<string>) => void
} = {}) {
  const prefix = namespace ? `-${namespace}` : "";
  const DB_NAME = `biscuit-store${prefix}`;
  const STORE_NAME = `biscuit-jar${prefix}`;
  const CHANNEL_NAME = `biscuit${prefix}`;
  const STORAGE_KEY = `biscuit-sync${prefix}`;

  let db;
  let debugEnabled = !!debug;
  let destroyed = false;

  const jar = new Map(); // key -> { key, value, expiry, ttl, fetcherId? }
  const refreshers = new Map(); // key -> function
  const refreshTimers = new Map();
  const accessTimestamps = new Map();

  // --- existing global subscribers
  const subscribers = new Set();
  // --- new per-key subscribers
  const keySubscribers = new Map();
  // persisted fetcher registry (id->fn) in-memory
  const fetcherRegistry = new Map();

  const refreshGenerations = new Map();

  function log(...args) { if (debugEnabled) console.log("[BISCUIT]", ...args); }

  // --- encryption setup (per-DB salt, fallback if no WebCrypto)
  const cryptoAvailable = typeof crypto !== "undefined" && crypto.subtle;
  let useEncryption = !!secret && cryptoAvailable;
  if (secret && !cryptoAvailable) console.warn("[BISCUIT] WebCrypto unavailable — encryption disabled.");

  function ab2base64(buffer) {
    log("Ab2 Base64", buffer);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base642ab(b64) {
    log("Base64 2ab", b64);
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function deriveCryptoKey(passphrase, saltBase64) {
    log("Derive crypto key", { passphrase, saltBase64 });
    const enc = new TextEncoder();
    const salt = base642ab(saltBase64);
    const passKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      passKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  let cryptoKeyPromise = null;
  let dbSaltBase64 = null;

  // --- IndexedDB helpers (namespace-separated DB and store)
  function openIDB() {
    log("Opening indexedDB...");
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        if (!_db.objectStoreNames.contains(STORE_NAME)) _db.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target?.error || new Error("IDB open failed"));
    });
  }

  function idbGet(key) {
    log("Get an item from indexedDB. Item key:", key);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  function idbGetAll() {
    log("Get all items in indexedDB");
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  function idbPut(obj) {
    log("Put / Save an item in indexedDB. Item object:", obj);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(obj);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  function idbDelete(key) {
    log("Delete an item in indexedDB. Item key:", key);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }
  function idbClear() {
    log("Clear up indexedDB");
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }

  // --- crypto helpers that use per-DB salt
  async function ensureCryptoKey() {
    log("Ensure crypto key");
    if (!useEncryption) return null;
    if (cryptoKeyPromise) return cryptoKeyPromise;
    if (!db) db = await openIDB(); // ensure db exists before reading meta
    // read meta salt
    const meta = await idbGet("__meta__").catch(() => null);
    if (meta && meta.salt) dbSaltBase64 = meta.salt;
    else {
      log("No meta or meta salt or both");
      const s = crypto.getRandomValues(new Uint8Array(16));
      dbSaltBase64 = ab2base64(s.buffer);
      try { await idbPut({ key: "__meta__", salt: dbSaltBase64 }); } catch (e) { log("meta write failed", e); }
    }
    cryptoKeyPromise = deriveCryptoKey(secret, dbSaltBase64);
    return cryptoKeyPromise;
  }

  async function encryptValue(value) {
    log("Encrypt value. Value:", value);
    if (!useEncryption) throw new Error("encryption disabled");
    const key = await ensureCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return { cipher: ab2base64(cipher), iv: ab2base64(iv.buffer) };
  }

  async function decryptValue(stored) {
    log("Decrypt stored value. Stored value:", stored);
    if (!useEncryption) throw new Error("encryption disabled");
    const key = await ensureCryptoKey();
    const iv = new Uint8Array(base642ab(stored.iv));
    const cipherBuf = base642ab(stored.cipher);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuf);
    const text = new TextDecoder().decode(plainBuf);
    return JSON.parse(text);
  }

  // --- cross-tab sync
  const channelSupported = typeof BroadcastChannel === "function";
  const channel = channelSupported ? new BroadcastChannel(CHANNEL_NAME) : null;

  function broadcastChange(key, entry) {
    // entry: null for deletion, otherwise { value, expiry, ttl, fetcherId }
    log("Broadcast change:", { key, entry });
    if (channelSupported) channel.postMessage({ key, entry });
    else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, entry, t: Date.now() })); }
      catch (e) { log("localStorage broadcast failed", e); }
    }
  }

  function handleRemoteUpdate(key, entry) {
    log("Remote update received:", { key, entry });
    const cur = jar.get(key);
    if (!entry) {
      // deletion
      if (cur) {
        jar.delete(key);
        accessTimestamps.delete(key);
        refreshers.delete(key);
        notify();
      }
      return;
    }
    // entry has value, expiry, ttl, fetcherId
    const newSerialized = JSON.stringify(entry.value);
    const curSerialized = cur ? JSON.stringify(cur.value) : null;
    const expiry = entry.expiry || (Date.now() + 5 * 60 * 1000);
    const ttl = entry.ttl || null;
    const fetcherId = entry.fetcherId || null;

    if (!cur || newSerialized !== curSerialized || cur.expiry !== expiry || cur.ttl !== ttl || cur.fetcherId !== fetcherId) {
      log("Remote update. Exact similar value does not exist, so updating.");
      jar.set(key, { key, value: entry.value, expiry, ttl, fetcherId });
      touchKey(key);
      // attach fetcher if available
      if (fetcherId && fetcherRegistry.has(fetcherId)) {
        refreshers.set(key, fetcherRegistry.get(fetcherId));
        scheduleRefresh(key, expiry);
      } else {
        refreshers.delete(key);
      }
      notify();
    }
  }

  if (channelSupported) channel.onmessage = (e) => handleRemoteUpdate(e.data.key, e.data.value);
  else window.addEventListener("storage", (e) => { if (e.key === STORAGE_KEY && e.newValue) { const { key, value } = JSON.parse(e.newValue); handleRemoteUpdate(key, value); } });

  // --- init: open db, load entries, prepare crypto + invoke missing fetcher callback
  async function init() {
    log("Initializing / Starting up");
    db = await openIDB();
    if (useEncryption) {
      try { await ensureCryptoKey(); } catch (e) { console.warn("[BISCUIT] crypto init failed — disabling encryption", e); useEncryption = false; cryptoKeyPromise = null; }
    }
    const all = await idbGetAll().catch(() => []);
    for (const e of all) {
      try {
        if (e.key === "__meta__") continue;
        let value = e.value;
        if (e.encrypted && useEncryption) {
          try { value = await decryptValue(e.value); } catch (err) { log("decrypt failed for", e.key, err); continue; }
        }
        if (Date.now() < e.expiry) {
          jar.set(e.key, { key: e.key, value, expiry: e.expiry, ttl: e.ttl, fetcherId: e.fetcherId });
          accessTimestamps.set(e.key, Date.now());
          // if fetcherId exists and registry has fn, attach
          if (e.fetcherId && fetcherRegistry.has(e.fetcherId)) {
            refreshers.set(e.key, fetcherRegistry.get(e.fetcherId));
            scheduleRefresh(e.key, e.expiry);
          }
        } else {
          // expired but we'll allow GC to remove it after retention unless accessed
          jar.set(e.key, { key: e.key, value, expiry: e.expiry, ttl: e.ttl, fetcherId: e.fetcherId });
          accessTimestamps.set(e.key, Date.now());
        }
      } catch (err) { console.warn("[BISCUIT] init entry error", err); }
    }

    // build missing fetcher id list and call callback if provided
    const missing = new Set();
    for (const [k, v] of jar.entries()) if (v.fetcherId && !fetcherRegistry.has(v.fetcherId)) missing.add(v.fetcherId);
    const missingArr = Array.from(missing);
    if (typeof onMissingFetchers === "function") {
      log("Handling mission fetcher id with onMissingFetcher function");
      try {
        // allow async callback; await it so app can register fetchers synchronously
        await onMissingFetchers(missingArr);
        // after callback returns, attach any registered fetchers
        for (const [k, v] of jar.entries()) {
          if (v.fetcherId && fetcherRegistry.has(v.fetcherId) && !refreshers.has(k)) {
            refreshers.set(k, fetcherRegistry.get(v.fetcherId));
            scheduleRefresh(k, v.expiry);
          }
        }
      } catch (e) {
        console.warn("[BISCUIT] onMissingFetchers callback threw", e);
      }
    }

    notify();
  }

  const dbReady = init();
  async function withDB(fn) { await dbReady; return fn(); }
  async function ready() { await dbReady; log("Biscuit ready"); }

  // --- persistence helper (encrypt if enabled) — stores fetcherId (string) if provided
  async function persist(key, value, expiry, ttl, fetcherId = null) {
    log("Persist key - value. Item:", { key, value, expiry, ttl, fetcherId });
    return withDB(async () => {
      try {
        let toStore = value;
        let encryptedFlag = false;
        if (useEncryption) {
          log("Persist key - value. useEncryption:", useEncryption);
          try { toStore = await encryptValue(value); encryptedFlag = true; } catch (e) { console.warn("[BISCUIT] encrypt failed, storing plaintext", e); encryptedFlag = false; toStore = value; }
        }
        await idbPut({ key, value: toStore, expiry, ttl, encrypted: encryptedFlag, fetcherId: fetcherId || null });
      } catch (err) { console.error("[BISCUIT] Persist failed:", err); }
    });
  }
  async function removeFromDB(key) { return withDB(async () => { try { await idbDelete(key); } catch (err) { console.error("[BISCUIT] Remove failed:", err); } }); }
  async function clearDB() { return withDB(async () => { try { await idbClear(); } catch (err) { console.error("[BISCUIT] Clear failed:", err); } }); }

  // --- snapshot & notify
  function getAll({ includeMeta = false } = {}) {
    log("Get all from in-memory Jar");
    const result = {};
    for (const [k, entry] of jar.entries()) result[k] = includeMeta ? { value: entry.value, ttl: entry.ttl, expiry: entry.expiry, fetcherId: entry.fetcherId } : entry.value;
    return result;
  }
  function notify() {
    log("Notify...");
    const snapshot = getAll();
    // global subscribers
    subscribers.forEach((fn) => { try { fn(snapshot); } catch (e) { log("subscriber error", e); } });
    // per-key subscribers
    for (const [key, subs] of keySubscribers.entries()) {
      const value = jar.get(key)?.value ?? null;
      subs.forEach((fn) => { try { fn(value); } catch (e) { log("key-subscriber error", e); } });
    }
  }

  // --- LRU helpers
  function touchKey(key) {
    log("Key touched. key:", key);
    accessTimestamps.set(key, Date.now());
    if (maxSize && accessTimestamps.size > Math.max(maxSize * 2, 1000)) {
      const entries = Array.from(accessTimestamps.entries()).sort((a, b) => b[1] - a[1]);
      const keep = entries.slice(0, maxSize * 2);
      accessTimestamps.clear();
      keep.forEach(([k, t]) => accessTimestamps.set(k, t));
    }
  }
  async function enforceMaxSizeIfNeeded() {
    log("Max size enforce if needed.");
    if (!maxSize) return;
    if (jar.size <= maxSize) return;
    const items = Array.from(accessTimestamps.entries()).sort((a, b) => a[1] - b[1]); // oldest first
    while (jar.size > maxSize && items.length) {
      const [evictKey] = items.shift();
      await remove(evictKey);
    }
  }

  // --- quota helpers (best-effort)
  async function checkQuotaAndMaybePurge() {
    log("Quota check and maybe purge.");
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      if (quota && usage / quota >= quotaWarningThreshold) {
        console.warn(`[BISCUIT] storage usage high`);
        await purgeOldestUntilBelow(quota * 0.8);
      }
    } catch (e) { log("Quota check failed", e); }
  }
  async function purgeOldestUntilBelow(targetBytes) {
    log("Purge oldest until it is below max size.");
    if (!maxSize) {
      const items = Array.from(accessTimestamps.entries()).sort((a, b) => a[1] - b[1]);
      for (const [key] of items) {
        await remove(key);
        try {
          const est = await navigator.storage.estimate();
          if (est.quota && est.usage && est.usage <= targetBytes) break;
        } catch (e) { }
      }
    } else {
      await enforceMaxSizeIfNeeded();
    }
  }

  // --- public API: set/get/mutate/remove/clear/subscribe
  async function set(key, value, ttl = 5 * 60 * 1000, fetcher = null) {
    ensureNotDestroyed();
    log("Set item. item:", { key, value, ttl, fetcher });
    if (typeof key !== "string" || !key) throw new Error("set() expects a non-empty string key");
    await dbReady;
    const expiry = Date.now() + ttl;
    const entry = { key, value, expiry, ttl };
    jar.set(key, entry);
    touchKey(key);

    if (jar.size === 1) startGcTimer(); // start GC when first entry arrives

    let fetcherIdToPersist = null;
    if (fetcher) {
      if (typeof fetcher === "function") {
        refreshers.set(key, fetcher);
      } else if (typeof fetcher === "object" && typeof fetcher.fn === "function" && fetcher.id) {
        refreshers.set(key, fetcher.fn);
        fetcherIdToPersist = fetcher.id;
        fetcherRegistry.set(fetcher.id, fetcher.fn);
      } else {
        log("Invalid fetcher passed to set()");
      }
    } else {
      refreshers.delete(key);
    }

    await persist(key, value, expiry, ttl, fetcherIdToPersist);
    broadcastChange(key, { value, expiry, ttl, fetcherId: fetcherIdToPersist });
    scheduleRefresh(key, expiry);
    await enforceMaxSizeIfNeeded();
    notify();
    checkQuotaAndMaybePurge().catch((e) => log("quota check error", e));
  }

  async function get(key, { extend = true, staleWhileRevalidate = false } = {}) {
    ensureNotDestroyed();
    log("Get item:", key);
    if (typeof key !== "string" || !key) throw new Error("get() expects a non-empty string key");
    await dbReady;
    const entry = jar.get(key);
    if (!entry) return null;
    const expired = Date.now() > entry.expiry;

    touchKey(key);

    if (expired) {
      log("Get item but expired")
      // on-demand immediate removal (unless staleWhileRevalidate + fetcher available)
      if (staleWhileRevalidate && refreshers.get(key)) {
        refresh(key).catch((e) => log("refresh error", e));
        return entry.value;
      }
      jar.delete(key);
      accessTimestamps.delete(key);
      await removeFromDB(key);
      broadcastChange(key, null);
      notify();
      return null;
    }

    if (extend) {
      log("Get item and extend")
      entry.expiry = Date.now() + (entry.ttl || 5 * 60 * 1000);
      await persist(key, entry.value, entry.expiry, entry.ttl, entry.fetcherId);
      scheduleRefresh(key, entry.expiry);
    }

    return entry.value;
  }

  async function mutate(key, mutator) {
    ensureNotDestroyed();
    log("Mutate item:", { key, mutator });
    if (typeof mutator !== "function") throw new Error("mutate() expects a function as second argument");
    if (typeof key !== "string" || !key) throw new Error("mutate() expects a non-empty string key");

    const entry = jar.get(key)
    if (!entry) return

    const current = await get(key, { extend: false });
    if (current === null) return;

    // capture generation before mutator runs
    const expectedGen = refreshGenerations.get(key) || 0;

    const newValue = await Promise.resolve(mutator(current));

    // check if another refresh/mutate changed the key in between
    if ((refreshGenerations.get(key) || 0) !== expectedGen) {
      log(`mutate() aborted for ${key} — value changed during mutation`);
      return;
    }
    // bump generation so later stale ops won't overwrite
    refreshGenerations.set(key, expectedGen + 1);

    await set(
      key,
      newValue,
      entry.ttl,
      // jar.get(key)?.ttl,
      refreshers.get(key) ? { fn: refreshers.get(key), id: entry.fetcherId } : null
    );
  }

  async function remove(key) {
    ensureNotDestroyed();
    log("Remove item:", key);
    if (typeof key !== "string" || !key) throw new Error("remove() expects a non-empty string key");
    if (!jar.has(key)) return;
    jar.delete(key);
    refreshers.delete(key);
    accessTimestamps.delete(key);

    // bump generation so pending refresh results are ignored
    refreshGenerations.set(key, (refreshGenerations.get(key) || 0) + 1);

    if (refreshTimers.has(key)) { clearTimeout(refreshTimers.get(key)); refreshTimers.delete(key); }
    await removeFromDB(key);
    broadcastChange(key, null);
    notify();
    if (jar.size === 0) stopGcTimer(); // stop GC when jar is empty
  }

  async function clear() {
    ensureNotDestroyed();
    log("Clear item:");
    jar.clear(); refreshers.clear(); accessTimestamps.clear();

    // bump generation for all keys so pending refreshes abort
    for (const key of refreshGenerations.keys()) {
      refreshGenerations.set(key, (refreshGenerations.get(key) || 0) + 1);
    }
    refreshTimers.forEach((t) => clearTimeout(t)); refreshTimers.clear();
    await clearDB();
    broadcastChange(null, null);
    notify();
    stopGcTimer(); // nothing left to GC
  }

  function subscribe(fn) { ensureNotDestroyed(); subscribers.add(fn); try { fn(getAll()); } catch (e) { } return () => subscribers.delete(fn); }
  function subscribeKey(key, fn) {
    ensureNotDestroyed();
    log("Subscribe key:", { key, fn });
    if (typeof key !== "string" || !key) throw new Error("subscribeKey() expects a non-empty string key");
    if (typeof fn !== "function") throw new Error("subscribeKey() expects a function as second argument");
    if (!keySubscribers.has(key)) keySubscribers.set(key, new Set());

    const setForKey = keySubscribers.get(key);
    setForKey.add(fn);

    // fire immediately with current value
    try { fn(jar.get(key)?.value ?? null); } catch (e) { }

    return () => {
      log("Returned unsubcribe function");
      setForKey.delete(fn);
      if (setForKey.size === 0) keySubscribers.delete(key);
    };
  }

  // --- refresh scheduling & execution (pauses when offline)
  let online = typeof navigator !== "undefined" ? navigator.onLine : true;
  function isOnline() { ensureNotDestroyed(); return online; }

  function scheduleRefresh(key, expiry) {
    log("Scheduling refresh", { key, expiry });
    const entry = jar.get(key);
    if (!entry || !isOnline()) return;

    // bump generation for this key
    const gen = (refreshGenerations.get(key) || 0) + 1;
    refreshGenerations.set(key, gen);

    if (refreshTimers.has(key)) clearTimeout(refreshTimers.get(key));

    const ttl = entry.ttl || 5 * 60 * 1000;
    const refreshTime = expiry - Date.now() - Math.floor(ttl * 0.1);

    if (refreshTime <= 0) {
      log("refreshTime less / equal to 0, so quick refrsh.");
      refresh(key, gen).catch((e) => log("immediate refresh error", e));
      return;
    }
    const timer = setTimeout(() => refresh(key, gen), refreshTime);
    refreshTimers.set(key, timer);
  }

  async function refresh(key, expectedGen = refreshGenerations.get(key)) {
    ensureNotDestroyed();
    log("Refreshing key:", key);
    const entry = jar.get(key)
    const fetcher = refreshers.get(key);
    if (!entry || !fetcher || !isOnline()) return;

    const currentGen = refreshGenerations.get(key);
    if (expectedGen !== currentGen) return; // superseded

    try {
      const freshValue = await fetcher();

      // Check conditions again after fetch resolves
      if (destroyed) return;
      if (!isOnline()) return;
      if (!jar.has(key)) return;
      if (expectedGen !== refreshGenerations.get(key)) return; // another refresh happened since

      // const fetcherId = jar.get(key)?.fetcherId || null;
      const fetcherId = entry.fetcherId
      await set(
        key,
        freshValue,
        entry.ttl,
        // jar.get(key)?.ttl,
        fetcherId ? { fn: fetcher, id: fetcherId } : fetcher
      );
      return true;
    } catch (e) {
      console.warn(`[BISCUIT] Refresh failed for ${key}:`, e);
      log("Retrying once");
      // retry once
      if (expectedGen === refreshGenerations.get(key)) {
        try {
          const retryValue = await fetcher();
          if (!destroyed && isOnline() && jar.has(key) && expectedGen === refreshGenerations.get(key)) {
            const fetcherId = entry.fetcherId
            await set(
              key,
              retryValue,
              entry.ttl,
              // jar.get(key)?.ttl,
              fetcherId ? { fn: fetcher, id: fetcherId } : fetcher
            );
          }
        } catch (err) {
          console.warn(`[BISCUIT] Refresh retry failed for ${key}:`, err);
        }
      }
    }
  }

  function has(key) { ensureNotDestroyed(); const entry = jar.get(key); return !!entry && Date.now() < entry.expiry; }
  function size({ includeExpired = false } = {}) {
    ensureNotDestroyed();
    if (includeExpired) return jar.size;
    const now = Date.now();
    let count = 0;
    for (const e of jar.values()) if (now < e.expiry) count++;
    return count;
  }
  function keys() { ensureNotDestroyed(); return Array.from(jar.keys()); }
  function enableDebug() { ensureNotDestroyed(); debugEnabled = true; log("Debug enabled"); }
  function disableDebug() { ensureNotDestroyed(); log("Debug disabled"); debugEnabled = false; }

  if (typeof window !== "undefined") window[`__BISCUIT__${prefix}`] = { jar, refreshers, refresh, clear, keys, size, getAll };

  // --- offline/online handling
  function handleWentOnline() {
    log("Online handled");
    online = true;
    for (const [key, entry] of jar.entries()) scheduleRefresh(key, entry.expiry);
    // refresh near-expiry items
    for (const [key, fetcher] of refreshers.entries()) {
      const e = jar.get(key);
      if (!e) continue;
      const ttl = e.ttl || 5 * 60 * 1000;
      if (e.expiry - Date.now() <= ttl * 0.15) refresh(key).catch((err) => log("refresh error", err));
    }
    notify();
  }
  function handleWentOffline() {
    log("Offline handled");
    online = false;
    for (const [k, t] of refreshTimers.entries()) clearTimeout(t);
    refreshTimers.clear();
    notify();
  }
  if (typeof window !== "undefined") { window.addEventListener("online", handleWentOnline); window.addEventListener("offline", handleWentOffline); }

  // --- Garbage collection: automatic, not user-called
  // Removes entries that have been expired for >= expiredRetention
  async function garbageCollectOnce() {
    log("Garbage collector collecting once!");
    const now = Date.now();
    const toRemove = [];
    for (const [key, entry] of jar.entries()) {
      if (now >= (entry.expiry + expiredRetention)) toRemove.push(key);
    }
    if (toRemove.length === 0) return;
    log("GC removing keys:", toRemove);
    for (const k of toRemove) {
      try { await remove(k); } catch (e) { log("GC remove failed", k, e); }
    }
  }

  // --- Garbage collection management
  let gcTimer = null;

  function startGcTimer() {
    if (gcTimer) return; // already running
    log("Start GC Timer!");
    gcTimer = setInterval(() => {
      garbageCollectOnce().catch((e) => log("GC error", e));
      checkQuotaAndMaybePurge().catch((e) => log("quota check error", e));
    }, gcInterval);
  }
  function stopGcTimer() {
    if (gcTimer) {
      log("Stop GC Timer!");
      clearInterval(gcTimer);
      gcTimer = null;
    }
  }

  // --- fetcher registration helpers (for persisted fetcherIds)
  function registerFetcher(id, fn) {
    ensureNotDestroyed();
    log("Registering fetcher", { id, fn });
    if (!id || typeof fn !== "function") throw new Error("registerFetcher expects (id, function)");
    fetcherRegistry.set(id, fn);
    for (const [k, v] of jar.entries()) {
      if (v.fetcherId === id) {
        refreshers.set(k, fn);
        scheduleRefresh(k, v.expiry);
      }
    }
  }
  function getMissingFetcherIds() {
    ensureNotDestroyed();
    log("Getting missing fetchers Id");
    const missing = new Set();
    for (const [k, v] of jar.entries()) if (v.fetcherId && !fetcherRegistry.has(v.fetcherId)) missing.add(v.fetcherId);
    return Array.from(missing);
  }

  // --- inspect utility for dev/debugging
  function inspect() {
    ensureNotDestroyed();
    log("Inspection!");
    const now = Date.now();

    const entries = {};
    for (const [key, entry] of jar.entries()) {
      entries[key] = {
        value: entry.value,
        ttl: entry.ttl ?? null,
        expiry: entry.expiry ?? null,
        expired: entry.expiry !== null && entry.expiry <= now,
        fetcherId: entry.fetcherId || null,
        fetcherRegistered: refreshers.has(key),
      };
    }

    return {
      now,
      entries,
      refreshers: Array.from(refreshers.keys()),
      refreshTimers: Array.from(refreshTimers.keys()),
      generations: Object.fromEntries(refreshGenerations.entries()),
      isOnline: isOnline(),
      destroyed,
      gcTimerActive: !!gcTimer,
      channelSupported,
      channelOpen: channelSupported && channel ? true : false,
    };
  }

  // --- graceful shutdown internal (for tests and public destroy)
  function destroy() {
    if (destroyed) return; // prevent double-destroy

    log("Destroying...");
    stopGcTimer();
    refreshTimers.forEach((t) => clearTimeout(t));
    refreshTimers.clear();

    if (channelSupported && channel) channel.close();

    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleWentOnline);
      window.removeEventListener("offline", handleWentOffline);
    }

    destroyed = true;
    log("Destroyed! Restart by making another Biscuit instance.");
  }

  // --- guard helper
  function ensureNotDestroyed() {
    if (destroyed) {
      throw new Error("Biscuit instance has been destroyed");
    }
  }

  // --- returned API
  return {
    ready,
    set,
    get,
    mutate,
    remove,
    clear,
    subscribe,
    subscribeKey,
    refresh,
    has,
    keys,
    size,
    enableDebug,
    disableDebug,
    isOnline,
    registerFetcher,
    getMissingFetcherIds,
    inspect,
    destroy,
    // internals for dev/testing (not necessary for normal use)
    __internal: { accessTimestamps, refreshers, refreshTimers, fetcherRegistry },
  };
}

// default convenience instance (namespace "")
const Biscuit = createBiscuit();
export default Biscuit;
export { createBiscuit };

/**
 * -------------------------------------------------------
 * 🏗️ FUTURE IMPROVEMENTS FOR BISCUIT
 * -------------------------------------------------------
 *
 * 2. **Cache Invalidation**
 *    - Provide `invalidate(key)` to force refresh on next `get()`.
 *    - Optionally allow cascading invalidation for related keys
 *      (e.g., invalidate `friends-*` keys when a friend changes).
 *
  * 3. **Batch Operations**
  * 
 *
 * 8. **TypeScript Enhancements**
 *    - Add types for `createBiscuit({ namespace })` so namespace-based
 *      instances get proper IntelliSense support.
 *
 * 9. **SSR / Hybrid Support**
 *    - Provide a no-op or memory-only version for Node.js / SSR.
 *
 * 10. **Custom TTL Policies**
 *     - Allow per-key refresh strategies:
 *       - `never` (manual refresh only)
 *       - `on-demand` (refresh when accessed after expiry)
 *       - `background` (current default)
 */
