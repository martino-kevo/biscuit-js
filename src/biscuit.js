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
  maxRetries = 1, // how many times to retry a failed background refresh
  retryDelay = (attempt) => Math.min(500 * 2 ** attempt, 10000), // backoff fn: attempt(1-based) -> ms
  fetchTimeout = null, // ms; null = no timeout. Caps how long a single fetcher() call may run.
  onError = null, // optional (error, context: string) => void — hook for telemetry/crash reporting
} = {}) {
  const prefix = namespace ? `-${namespace}` : "";
  const DB_NAME = `biscuit-store${prefix}`;
  const STORE_NAME = `biscuit-jar${prefix}`;
  const CHANNEL_NAME = `biscuit${prefix}`;
  const STORAGE_KEY = `biscuit-sync${prefix}`;

  // --- SSR / non-browser support, and graceful degradation: fall back to
  // memory-only operation instead of throwing when indexedDB/window aren't
  // present (Node, RN, SSR) OR when IndexedDB exists but fails to open
  // (private-browsing restrictions, storage disabled by policy, a
  // corrupted DB, etc.) — see init() below for the latter case.
  const idbAvailable = typeof indexedDB !== "undefined";
  let idbUsable = idbAvailable; // flips to false at runtime if openIDB() fails
  const windowAvailable = typeof window !== "undefined";
  if (!idbAvailable) {
    console.warn(
      "[BISCUIT] indexedDB is unavailable in this environment — running in memory-only mode (nothing will persist across reloads)."
    );
  }

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
  const pendingRefreshes = new Map(); // key -> in-flight refresh Promise<boolean>
  const activeAbortControllers = new Map(); // key -> AbortController for the current fetcher() call
  const abortSupported = typeof AbortController !== "undefined";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Caps how long a single fetcher() call is awaited. If an onTimeout
  // callback is given (used to abort()), it's invoked when the deadline
  // hits, so a well-behaved fetcher can actually stop the underlying work
  // instead of just being ignored. Fetchers that don't respect the signal
  // still get a "soft" timeout: Biscuit stops waiting, but the call itself
  // keeps running until it settles on its own.
  function withTimeout(promise, ms, label, onTimeout) {
    if (!ms) return promise;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (onTimeout) {
          try {
            onTimeout();
          } catch (_) {
            /* ignore */
          }
        }
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  function log(...args) {
    if (debugEnabled) console.log("[BISCUIT]", ...args);
  }

  // Errors that shouldn't crash the caller (background refresh failures,
  // persistence failures, broadcast failures) still need to be observable
  // in production, where console output usually isn't monitored.
  function reportError(context, error) {
    console.error(`[BISCUIT] ${context}:`, error);
    if (typeof onError === "function") {
      try {
        onError(error, context);
      } catch (handlerErr) {
        console.error("[BISCUIT] onError handler itself threw:", handlerErr);
      }
    }
  }

  // --- encryption setup (per-DB salt, fallback if no WebCrypto)
  const cryptoAvailable = typeof crypto !== "undefined" && crypto.subtle;
  let useEncryption = !!secret && cryptoAvailable;
  if (secret && !cryptoAvailable)
    console.warn("[BISCUIT] WebCrypto unavailable — encryption disabled.");

  function ab2base64(buffer) {
    log("Ab2 Base64", buffer);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++)
      binary += String.fromCharCode(bytes[i]);
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
    const passKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
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
    if (!idbUsable) return Promise.resolve(null);
    log("Opening indexedDB...");
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        if (!_db.objectStoreNames.contains(STORE_NAME))
          _db.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) =>
        reject(e.target?.error || new Error("IDB open failed"));
    });
  }

  function idbGet(key) {
    if (!idbUsable) return Promise.resolve(undefined);
    log("Get an item from indexedDB. Item key:", key);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }
  function idbGetAll() {
    if (!idbUsable) return Promise.resolve([]);
    log("Get all items in indexedDB");
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }
  function idbPut(obj) {
    if (!idbUsable) return Promise.resolve();
    log("Put / Save an item in indexedDB. Item object:", obj);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(obj);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }
  function idbDelete(key) {
    if (!idbUsable) return Promise.resolve();
    log("Delete an item in indexedDB. Item key:", key);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }
  function idbClear() {
    if (!idbUsable) return Promise.resolve();
    log("Clear up indexedDB");
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
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
      try {
        await idbPut({ key: "__meta__", salt: dbSaltBase64 });
      } catch (e) {
        log("meta write failed", e);
      }
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
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded
    );
    return { cipher: ab2base64(cipher), iv: ab2base64(iv.buffer) };
  }

  async function decryptValue(stored) {
    log("Decrypt stored value. Stored value:", stored);
    if (!useEncryption) throw new Error("encryption disabled");
    const key = await ensureCryptoKey();
    const iv = new Uint8Array(base642ab(stored.iv));
    const cipherBuf = base642ab(stored.cipher);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipherBuf
    );
    const text = new TextDecoder().decode(plainBuf);
    return JSON.parse(text);
  }

  // --- cross-tab sync
  const channelSupported = typeof BroadcastChannel === "function";
  const channel = channelSupported ? new BroadcastChannel(CHANNEL_NAME) : null;

  function broadcastChange(key, entry) {
    // entry: null for deletion, otherwise { value, expiry, ttl, fetcherId }
    log("Broadcast change:", { key, entry });
    if (channelSupported) {
      try {
        channel.postMessage({ key, entry });
      } catch (e) {
        // Most commonly DataCloneError — the cached value contains something
        // structured-clone can't handle (a function, DOM node, etc). The
        // local write already succeeded; don't let this throw out of
        // set()/remove()/clear() and make a successful write look failed.
        reportError(`Cross-tab broadcast failed for key "${key}"`, e);
      }
    } else {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ key, entry, t: Date.now() })
        );
      } catch (e) {
        log("localStorage broadcast failed", e);
      }
    }
  }

  function handleRemoteUpdate(key, entry) {
    log("Remote update received:", { key, entry });

    // full-store clear from another tab (see clear())
    if (key === null) {
      log("Remote update is a full clear — wiping in-memory jar");
      jar.clear();
      refreshers.clear();
      accessTimestamps.clear();
      refreshTimers.forEach((t) => clearTimeout(t));
      refreshTimers.clear();
      notify();
      return;
    }

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
    // Values that can't be JSON.stringify'd (circular refs, BigInt, etc.)
    // just skip the equality optimization below and always apply the
    // update — correctness over a perf shortcut.
    let valuesDiffer = true;
    try {
      valuesDiffer = JSON.stringify(entry.value) !== (cur ? JSON.stringify(cur.value) : null);
    } catch (e) {
      log("Could not compare remote value (non-serializable) — applying update anyway", e);
    }
    const expiry = entry.expiry || Date.now() + 5 * 60 * 1000;
    const ttl = entry.ttl || null;
    const fetcherId = entry.fetcherId || null;
    const refreshPolicy = entry.refreshPolicy || "background";

    if (
      !cur ||
      valuesDiffer ||
      cur.expiry !== expiry ||
      cur.ttl !== ttl ||
      cur.fetcherId !== fetcherId ||
      cur.refreshPolicy !== refreshPolicy
    ) {
      log("Remote update. Exact similar value does not exist, so updating.");
      jar.set(key, { key, value: entry.value, expiry, ttl, fetcherId, refreshPolicy });
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

  if (channelSupported)
    channel.onmessage = (e) => handleRemoteUpdate(e.data.key, e.data.entry);
  else if (windowAvailable)
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const { key, entry } = JSON.parse(e.newValue);
        handleRemoteUpdate(key, entry);
      }
    });

  // --- init: open db, load entries, prepare crypto + invoke missing fetcher callback
  async function init() {
    log("Initializing / Starting up");
    try {
      db = await openIDB();
    } catch (e) {
      reportError(
        "IndexedDB failed to open — falling back to memory-only mode for this session",
        e
      );
      idbUsable = false;
      db = null;
    }
    if (useEncryption) {
      try {
        await ensureCryptoKey();
      } catch (e) {
        console.warn("[BISCUIT] crypto init failed — disabling encryption", e);
        useEncryption = false;
        cryptoKeyPromise = null;
      }
    }
    const all = await idbGetAll().catch(() => []);
    for (const e of all) {
      try {
        if (e.key === "__meta__") continue;
        let value = e.value;
        if (e.encrypted && useEncryption) {
          try {
            value = await decryptValue(e.value);
          } catch (err) {
            log("decrypt failed for", e.key, err);
            continue;
          }
        }
        if (Date.now() < e.expiry) {
          jar.set(e.key, {
            key: e.key,
            value,
            expiry: e.expiry,
            ttl: e.ttl,
            fetcherId: e.fetcherId,
            refreshPolicy: e.refreshPolicy || "background",
          });
          accessTimestamps.set(e.key, Date.now());
          // if fetcherId exists and registry has fn, attach
          if (e.fetcherId && fetcherRegistry.has(e.fetcherId)) {
            refreshers.set(e.key, fetcherRegistry.get(e.fetcherId));
            scheduleRefresh(e.key, e.expiry);
          }
        } else {
          // expired but we'll allow GC to remove it after retention unless accessed
          jar.set(e.key, {
            key: e.key,
            value,
            expiry: e.expiry,
            ttl: e.ttl,
            fetcherId: e.fetcherId,
            refreshPolicy: e.refreshPolicy || "background",
          });
          accessTimestamps.set(e.key, Date.now());
        }
      } catch (err) {
        console.warn("[BISCUIT] init entry error", err);
      }
    }

    // build missing fetcher id list and call callback if provided
    const missing = new Set();
    for (const [k, v] of jar.entries())
      if (v.fetcherId && !fetcherRegistry.has(v.fetcherId))
        missing.add(v.fetcherId);
    const missingArr = Array.from(missing);
    if (typeof onMissingFetchers === "function") {
      log("Handling mission fetcher id with onMissingFetcher function");
      try {
        // allow async callback; await it so app can register fetchers synchronously
        await onMissingFetchers(missingArr);
        // after callback returns, attach any registered fetchers
        for (const [k, v] of jar.entries()) {
          if (
            v.fetcherId &&
            fetcherRegistry.has(v.fetcherId) &&
            !refreshers.has(k)
          ) {
            refreshers.set(k, fetcherRegistry.get(v.fetcherId));
            scheduleRefresh(k, v.expiry);
          }
        }
      } catch (e) {
        console.warn("[BISCUIT] onMissingFetchers callback threw", e);
        reportError("onMissingFetchers callback threw", e);
      }
    }

    notify();
  }

  const dbReady = init();
  async function withDB(fn) {
    await dbReady;
    return fn();
  }
  async function ready() {
    await dbReady;
    log("Biscuit ready");
  }

  // --- persistence helper (encrypt if enabled) — stores fetcherId (string) if provided
  async function persist(key, value, expiry, ttl, fetcherId = null, refreshPolicy = "background") {
    log("Persist key - value. Item:", { key, value, expiry, ttl, fetcherId, refreshPolicy });
    return withDB(async () => {
      try {
        let toStore = value;
        let encryptedFlag = false;
        if (useEncryption) {
          log("Persist key - value. useEncryption:", useEncryption);
          try {
            toStore = await encryptValue(value);
            encryptedFlag = true;
          } catch (e) {
            console.warn("[BISCUIT] encrypt failed, storing plaintext", e);
            encryptedFlag = false;
            toStore = value;
          }
        }
        const record = {
          key,
          value: toStore,
          expiry,
          ttl,
          encrypted: encryptedFlag,
          fetcherId: fetcherId || null,
          refreshPolicy,
        };
        try {
          await idbPut(record);
        } catch (err) {
          if (err && err.name === "QuotaExceededError") {
            log("Quota exceeded on write — evicting oldest entries and retrying once");
            try {
              await purgeOldestUntilBelow(0); // best-effort: free up space, then retry
              await idbPut(record);
            } catch (retryErr) {
              reportError(`Persist failed for key "${key}" (quota exceeded, retry also failed)`, retryErr);
            }
          } else {
            reportError(`Persist failed for key "${key}"`, err);
          }
        }
      } catch (err) {
        reportError(`Persist failed for key "${key}"`, err);
      }
    });
  }
  async function removeFromDB(key) {
    return withDB(async () => {
      try {
        await idbDelete(key);
      } catch (err) {
        reportError(`IndexedDB remove failed for key "${key}"`, err);
      }
    });
  }
  async function clearDB() {
    return withDB(async () => {
      try {
        await idbClear();
      } catch (err) {
        reportError("IndexedDB clear failed", err);
      }
    });
  }

  // --- snapshot & notify
  function getAll({ includeMeta = false } = {}) {
    log("Get all from in-memory Jar");
    const result = {};
    for (const [k, entry] of jar.entries())
      result[k] = includeMeta
        ? {
            value: entry.value,
            ttl: entry.ttl,
            expiry: entry.expiry,
            fetcherId: entry.fetcherId,
          }
        : entry.value;
    return result;
  }
  function notify() {
    log("Notify...");
    const snapshot = getAll();
    // global subscribers
    subscribers.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (e) {
        log("subscriber error", e);
      }
    });
    // per-key subscribers
    for (const [key, subs] of keySubscribers.entries()) {
      const value = jar.get(key)?.value ?? null;
      subs.forEach((fn) => {
        try {
          fn(value);
        } catch (e) {
          log("key-subscriber error", e);
        }
      });
    }
  }

  // --- LRU helpers
  function touchKey(key) {
    log("Key touched. key:", key);
    accessTimestamps.set(key, Date.now());
    if (maxSize && accessTimestamps.size > Math.max(maxSize * 2, 1000)) {
      const entries = Array.from(accessTimestamps.entries()).sort(
        (a, b) => b[1] - a[1]
      );
      const keep = entries.slice(0, maxSize * 2);
      accessTimestamps.clear();
      keep.forEach(([k, t]) => accessTimestamps.set(k, t));
    }
  }
  async function enforceMaxSizeIfNeeded() {
    log("Max size enforce if needed.");
    if (!maxSize) return;
    if (jar.size <= maxSize) return;
    const items = Array.from(accessTimestamps.entries()).sort(
      (a, b) => a[1] - b[1]
    ); // oldest first
    while (jar.size > maxSize && items.length) {
      const [evictKey] = items.shift();
      await remove(evictKey);
    }
  }

  // --- quota helpers (best-effort)
  async function checkQuotaAndMaybePurge() {
    log("Quota check and maybe purge.");
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate) return;
    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      if (quota && usage / quota >= quotaWarningThreshold) {
        console.warn(`[BISCUIT] storage usage high`);
        await purgeOldestUntilBelow(quota * 0.8);
      }
    } catch (e) {
      log("Quota check failed", e);
    }
  }
  async function purgeOldestUntilBelow(targetBytes) {
    log("Purge oldest until it is below max size.");
    if (!maxSize) {
      const items = Array.from(accessTimestamps.entries()).sort(
        (a, b) => a[1] - b[1]
      );
      for (const [key] of items) {
        await remove(key);
        try {
          const est = await navigator.storage.estimate();
          if (est.quota && est.usage && est.usage <= targetBytes) break;
        } catch (e) {}
      }
    } else {
      await enforceMaxSizeIfNeeded();
    }
  }

  // Rebind fetcher if missing
  function ensureFetcherBound(key) {
    const entry = jar.get(key);
    if (!entry?.fetcherId || refreshers.has(key)) return; // already bound or no fetcher id

    const fn = fetcherRegistry.get(entry.fetcherId);
    if (fn) {
      refreshers.set(key, fn);
      log(`Rebound fetcher for ${key} via ensureFetcherBound`);
      scheduleRefresh(key, entry.expiry);
    } else {
      log(`Missing fetcher for id: ${entry.fetcherId} on key: ${key}`);
    }
  }

  // --- public API: set/get/mutate/remove/clear/subscribe
  async function set(key, value, ttl = 5 * 60 * 1000, fetcher = null, options = {}) {
    ensureNotDestroyed();
    log("Set item. item:", { key, value, ttl, fetcher, options });
    if (typeof key !== "string" || !key)
      throw new Error("set() expects a non-empty string key");
    if (key === "__meta__")
      throw new Error('"__meta__" is a reserved Biscuit key and cannot be set');
    await dbReady;
    const existingEntry = jar.get(key);
    const refreshPolicy = options.refreshPolicy || existingEntry?.refreshPolicy || "background";
    if (!["background", "on-demand", "never"].includes(refreshPolicy))
      throw new Error(
        `set() refreshPolicy must be "background", "on-demand", or "never" (got "${refreshPolicy}")`
      );
    const expiry = Date.now() + ttl;
    const entry = { key, value, expiry, ttl, refreshPolicy };
    jar.set(key, entry);
    touchKey(key);

    if (jar.size >= 1) startGcTimer(); // start GC when entry arrives

    let fetcherIdToPersist = null;
    if (fetcher) {
      if (typeof fetcher === "function") {
        refreshers.set(key, fetcher);
      } else if (
        typeof fetcher === "object" &&
        typeof fetcher.fn === "function" &&
        fetcher.id
      ) {
        refreshers.set(key, fetcher.fn);
        fetcherIdToPersist = fetcher.id;
        fetcherRegistry.set(fetcher.id, fetcher.fn);
      } else {
        log("Invalid fetcher passed to set()");
      }
    } else {
      refreshers.delete(key);
    }

    entry.fetcherId = fetcherIdToPersist;
    await persist(key, value, expiry, ttl, fetcherIdToPersist, refreshPolicy);
    broadcastChange(key, { value, expiry, ttl, fetcherId: fetcherIdToPersist, refreshPolicy });
    scheduleRefresh(key, expiry);
    await enforceMaxSizeIfNeeded();
    notify();
    checkQuotaAndMaybePurge().catch((e) => log("quota check error", e));
  }

  async function get(
    key,
    { extend = true, staleWhileRevalidate = false, blocking = false } = {}
  ) {
    ensureNotDestroyed();
    log("Get item:", key);
    if (typeof key !== "string" || !key)
      throw new Error("get() expects a non-empty string key");
    await dbReady;
    const entry = jar.get(key);
    if (!entry) return null;
    const expired = Date.now() > entry.expiry;

    touchKey(key);

    if (expired) {
      log("Get item but expired");
      const fetcher = refreshers.get(key);
      const autoRefreshAllowed = !!fetcher && entry.refreshPolicy !== "never";

      // Explicit blocking request — caller needs a freshness guarantee
      // before proceeding (e.g. re-checking a permission right before a
      // sensitive action). Rare; most callers should not set this.
      if (blocking && autoRefreshAllowed) {
        const ok = await refresh(key).catch((e) => {
          log("blocking refresh error", e);
          return false;
        });
        if (ok) return jar.get(key)?.value ?? null;
        // refresh failed — fall through to normal expiry handling below
      }

      // Non-blocking stale-while-revalidate. This is ALWAYS the behavior
      // for "on-demand" keys (that's the point of on-demand: fetch lazily
      // on access, but never make the caller wait on the network) — and
      // it's opt-in for "background" keys via staleWhileRevalidate, for
      // the rare case where a key expires before its scheduled refresh
      // catches up (e.g. after being offline).
      if (autoRefreshAllowed && (entry.refreshPolicy === "on-demand" || staleWhileRevalidate)) {
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
      log("Get item and extend");
      // 🔁 Ensure fetcher is rebound if missing
      ensureFetcherBound(key); // ✅ always rebind on access

      // 🕒 Extend expiry and persist
      entry.expiry = Date.now() + (entry.ttl || 5 * 60 * 1000);
      await persist(key, entry.value, entry.expiry, entry.ttl, entry.fetcherId, entry.refreshPolicy);

      scheduleRefresh(key, entry.expiry);
    }

    // 🩹 Fix: rebind fetcher if lost after reload or GC
    ensureFetcherBound(key); // ✅ always rebind on access
    return entry.value;
  }

  async function mutate(key, mutator) {
    ensureNotDestroyed();
    log("Mutate item:", { key, mutator });
    if (typeof mutator !== "function")
      throw new Error("mutate() expects a function as second argument");
    if (typeof key !== "string" || !key)
      throw new Error("mutate() expects a non-empty string key");

    const entry = jar.get(key);
    if (!entry) return;

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
      refreshers.get(key)
        ? { fn: refreshers.get(key), id: entry.fetcherId }
        : null
    );
  }

  async function remove(key) {
    ensureNotDestroyed();
    log("Remove item:", key);
    if (typeof key !== "string" || !key)
      throw new Error("remove() expects a non-empty string key");
    await dbReady;
    if (!jar.has(key)) return;
    jar.delete(key);
    refreshers.delete(key);
    accessTimestamps.delete(key);

    // bump generation so pending refresh results are ignored
    refreshGenerations.set(key, (refreshGenerations.get(key) || 0) + 1);

    if (refreshTimers.has(key)) {
      clearTimeout(refreshTimers.get(key));
      refreshTimers.delete(key);
    }
    await removeFromDB(key);
    broadcastChange(key, null);
    notify();
    if (jar.size === 0) stopGcTimer(); // stop GC when jar is empty
  }

  async function clear() {
    ensureNotDestroyed();
    log("Clear item:");
    await dbReady;
    jar.clear();
    refreshers.clear();
    accessTimestamps.clear();

    // bump generation for all keys so pending refreshes abort
    for (const key of refreshGenerations.keys()) {
      refreshGenerations.set(key, (refreshGenerations.get(key) || 0) + 1);
    }
    refreshTimers.forEach((t) => clearTimeout(t));
    refreshTimers.clear();
    await clearDB();
    broadcastChange(null, null);
    notify();
    stopGcTimer(); // nothing left to GC
  }

  function subscribe(fn) {
    ensureNotDestroyed();
    subscribers.add(fn);
    try {
      fn(getAll());
    } catch (e) {}
    return () => subscribers.delete(fn);
  }
  function subscribeKey(key, fn) {
    ensureNotDestroyed();
    log("Subscribe key:", { key, fn });
    if (typeof key !== "string" || !key)
      throw new Error("subscribeKey() expects a non-empty string key");
    if (typeof fn !== "function")
      throw new Error("subscribeKey() expects a function as second argument");
    if (!keySubscribers.has(key)) keySubscribers.set(key, new Set());

    ensureFetcherBound(key); // ✅ auto rebind if missing

    const setForKey = keySubscribers.get(key);
    setForKey.add(fn);

    // fire immediately with current value
    try {
      fn(jar.get(key)?.value ?? null);
    } catch (e) {}

    return () => {
      log("Returned unsubcribe function");
      setForKey.delete(fn);
      if (setForKey.size === 0) keySubscribers.delete(key);
    };
  }

  // --- refresh scheduling & execution (pauses when offline)
  let online =
    typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
      ? navigator.onLine
      : true;
  function isOnline() {
    ensureNotDestroyed();
    return online;
  }

  function scheduleRefresh(key, expiry) {
    log("Scheduling refresh", { key, expiry });
    const entry = jar.get(key);
    if (!entry || !isOnline()) return;
    if (entry.refreshPolicy === "never" || entry.refreshPolicy === "on-demand") {
      log(`Skipping auto-schedule for ${key} — refreshPolicy is "${entry.refreshPolicy}"`);
      return;
    }

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
    const timer = setTimeout(() => {
      refresh(key, gen).catch((e) => log("scheduled refresh error", e));
    }, refreshTime);
    refreshTimers.set(key, timer);
  }

  async function refresh(key, expectedGen = refreshGenerations.get(key)) {
    ensureNotDestroyed();
    // de-duplicate concurrent refresh calls for the same key — share one in-flight fetch
    if (pendingRefreshes.has(key)) {
      log("Refresh already in-flight for", key, "— reusing promise");
      return pendingRefreshes.get(key);
    }
    const promise = doRefresh(key, expectedGen).finally(() => {
      pendingRefreshes.delete(key);
    });
    pendingRefreshes.set(key, promise);
    return promise;
  }

  async function doRefresh(key, expectedGen) {
    log("Refreshing key:", key);
    const entry = jar.get(key);
    const fetcher = refreshers.get(key);
    if (!entry || !fetcher || !isOnline()) return false;

    const currentGen = refreshGenerations.get(key);
    if (expectedGen !== currentGen) return false; // superseded

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelay(attempt);
        log(`Retry #${attempt} for ${key} after ${delay}ms`);
        await sleep(delay);
        if (
          destroyed ||
          !isOnline() ||
          !jar.has(key) ||
          expectedGen !== refreshGenerations.get(key)
        )
          return false; // conditions changed while waiting to retry
      }
      const controller = abortSupported ? new AbortController() : null;
      if (controller) activeAbortControllers.set(key, controller);
      try {
        const freshValue = await withTimeout(
          Promise.resolve(fetcher(controller ? controller.signal : undefined)),
          fetchTimeout,
          `Fetcher for key "${key}"`,
          controller
            ? () => controller.abort(new Error(`fetchTimeout of ${fetchTimeout}ms exceeded`))
            : undefined
        );

        if (destroyed) return false;
        if (!isOnline()) return false;
        if (!jar.has(key)) return false;
        if (expectedGen !== refreshGenerations.get(key)) return false; // superseded mid-fetch

        const fetcherId = entry.fetcherId;
        await set(
          key,
          freshValue,
          entry.ttl,
          fetcherId ? { fn: fetcher, id: fetcherId } : fetcher
        );
        return true;
      } catch (e) {
        lastErr = e;
        console.warn(
          `[BISCUIT] Refresh attempt ${attempt + 1}/${maxRetries + 1} failed for ${key}:`,
          e
        );
      } finally {
        if (controller && activeAbortControllers.get(key) === controller) {
          activeAbortControllers.delete(key);
        }
      }
    }
    console.warn(`[BISCUIT] Refresh exhausted retries for ${key}`, lastErr);
    reportError(`Background refresh exhausted retries for key "${key}"`, lastErr);
    return false;
  }

  function has(key) {
    ensureNotDestroyed();
    const entry = jar.get(key);
    return !!entry && Date.now() < entry.expiry;
  }

  // --- invalidation: force expiry now, so the next get() (or an active
  // background/on-demand fetcher) picks up a fresh value
  async function invalidate(key) {
    ensureNotDestroyed();
    log("Invalidate key:", key);
    if (typeof key !== "string" || !key)
      throw new Error("invalidate() expects a non-empty string key");
    const entry = jar.get(key);
    if (!entry) return false;

    entry.expiry = Date.now() - 1;
    await persist(key, entry.value, entry.expiry, entry.ttl, entry.fetcherId, entry.refreshPolicy);
    broadcastChange(key, {
      value: entry.value,
      expiry: entry.expiry,
      ttl: entry.ttl,
      fetcherId: entry.fetcherId,
      refreshPolicy: entry.refreshPolicy,
    });

    // if a fetcher is attached, kick off a refresh right away rather than
    // waiting for the next get() call to notice the expiry
    if (refreshers.has(key)) {
      refresh(key).catch((e) => log("invalidate refresh error", e));
    }
    notify();
    return true;
  }

  // --- pattern invalidation: '*' wildcard string, or a RegExp
  async function invalidatePattern(pattern) {
    ensureNotDestroyed();
    log("Invalidate pattern:", pattern);
    let re;
    if (pattern instanceof RegExp) re = pattern;
    else if (typeof pattern === "string") {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
    } else {
      throw new Error("invalidatePattern() expects a string or RegExp");
    }
    const matched = Array.from(jar.keys()).filter((k) => re.test(k));
    await Promise.all(matched.map((k) => invalidate(k)));
    return matched;
  }

  // --- batch operations
  async function setMany(items) {
    ensureNotDestroyed();
    if (!Array.isArray(items))
      throw new Error("setMany() expects an array of { key, value, ttl?, fetcher?, options? }");
    return Promise.all(
      items.map((item) =>
        set(item.key, item.value, item.ttl, item.fetcher, item.options)
      )
    );
  }
  async function getMany(keys, options) {
    ensureNotDestroyed();
    if (!Array.isArray(keys))
      throw new Error("getMany() expects an array of string keys");
    const results = await Promise.all(keys.map((k) => get(k, options)));
    const out = {};
    keys.forEach((k, i) => (out[k] = results[i]));
    return out;
  }

  // --- waitFor: resolve the first time a key has a (non-null) value
  const pendingWaitForRejects = new Set(); // cleared/rejected on destroy()

  function waitFor(key, { timeout = null } = {}) {
    ensureNotDestroyed();
    if (typeof key !== "string" || !key)
      throw new Error("waitFor() expects a non-empty string key");
    const current = jar.get(key);
    if (current && Date.now() < current.expiry && current.value != null) {
      return Promise.resolve(current.value);
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => pendingWaitForRejects.delete(rejectEntry);
      const rejectEntry = (err) => {
        cleanup();
        reject(err);
      };
      pendingWaitForRejects.add(rejectEntry);
      const unsub = subscribeKey(key, (value) => {
        if (value != null) {
          if (timer) clearTimeout(timer);
          unsub();
          cleanup();
          resolve(value);
        }
      });
      if (timeout) {
        timer = setTimeout(() => {
          unsub();
          rejectEntry(new Error(`waitFor("${key}") timed out after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  // --- best-effort storage usage estimate, exposed publicly
  async function estimateUsage() {
    ensureNotDestroyed();
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate)
      return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, percent: quota ? usage / quota : 0 };
    } catch (e) {
      log("estimateUsage failed", e);
      return null;
    }
  }
  function size({ includeExpired = false } = {}) {
    ensureNotDestroyed();
    if (includeExpired) return jar.size;
    const now = Date.now();
    let count = 0;
    for (const e of jar.values()) if (now < e.expiry) count++;
    return count;
  }
  function keys() {
    ensureNotDestroyed();
    return Array.from(jar.keys());
  }
  function enableDebug() {
    ensureNotDestroyed();
    debugEnabled = true;
    log("Debug enabled");
  }
  function disableDebug() {
    ensureNotDestroyed();
    log("Debug disabled");
    debugEnabled = false;
  }

  if (typeof window !== "undefined")
    window[`__BISCUIT__${prefix}`] = {
      jar,
      refreshers,
      refresh,
      clear,
      keys,
      size,
      getAll,
    };

  // --- offline/online handling
  function handleWentOnline() {
    log("Online handled");
    online = true;
    for (const [key, entry] of jar.entries())
      scheduleRefresh(key, entry.expiry);
    // refresh near-expiry items
    for (const [key, fetcher] of refreshers.entries()) {
      const e = jar.get(key);
      if (!e) continue;
      const ttl = e.ttl || 5 * 60 * 1000;
      if (e.expiry - Date.now() <= ttl * 0.15)
        refresh(key).catch((err) => log("refresh error", err));
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
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleWentOnline);
    window.addEventListener("offline", handleWentOffline);
  }

  // --- Garbage collection: automatic, not user-called
  // Removes entries that have been expired for >= expiredRetention
  async function garbageCollectOnce() {
    log("Garbage collector collecting once!");
    const now = Date.now();
    const toRemove = [];
    for (const [key, entry] of jar.entries()) {
      if (now >= entry.expiry + expiredRetention) toRemove.push(key);
    }
    if (toRemove.length === 0) return;
    log("GC removing keys:", toRemove);
    for (const k of toRemove) {
      try {
        await remove(k);
      } catch (e) {
        log("GC remove failed", k, e);
      }
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
    if (!id || typeof fn !== "function")
      throw new Error("registerFetcher expects (id, function)");
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
    for (const [k, v] of jar.entries())
      if (v.fetcherId && !fetcherRegistry.has(v.fetcherId))
        missing.add(v.fetcherId);
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

    activeAbortControllers.forEach((controller) => {
      try {
        controller.abort(new Error("Biscuit instance was destroyed"));
      } catch (_) {
        /* ignore */
      }
    });
    activeAbortControllers.clear();

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
    invalidate,
    invalidatePattern,
    setMany,
    getMany,
    waitFor,
    estimateUsage,
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
    __internal: {
      accessTimestamps,
      refreshers,
      refreshTimers,
      fetcherRegistry,
      pendingRefreshes,
    },
  };
}

// default convenience instance (namespace "")
const Biscuit = createBiscuit();
export default Biscuit;
export { createBiscuit };
