# 🍪 Biscuit.js

**Memory-first, persistent, reactive browser cache with background refresh & cross-tab sync.**

---

## ✨ Features
- **Memory-first** – Instant reads from a fast in-memory Map
- **Persistent** – Falls back to IndexedDB for reload-safe storage
- **Reactive** – Subscribe to updates for live UI state
- **TTL & Auto-Expiry** – Data expires automatically after configurable `ttl`
- **Background Refresh** – Optionally re-fetch data before it goes stale, with configurable per-key refresh policies
- **Cross-Tab Sync** – Stays in sync across browser tabs/windows
- **Namespaces** – Run multiple isolated stores side by side
- **Resilient** – Retries with backoff, fetch timeouts, and abortable fetchers out of the box
- **SSR-safe** – Falls back to memory-only automatically in Node/SSR, no crashes
- **Tiny & Dependency-free** – Pure JavaScript, no React or framework lock-in (React hooks available as an optional add-on)

---

## 📦 Installation
```sh
npm install biscuit-cache-js
```

## 🚀 Quick Start
```js
import Biscuit from "biscuit-cache-js";

async function main() {
  // 1️⃣ Store data with TTL (5 min default)
  await Biscuit.set("user", { id: 1, name: "Martins" });

  // 2️⃣ Retrieve data
  console.log(await Biscuit.get("user"));
  // => { id: 1, name: "Martins" }

  // 3️⃣ Subscribe to updates
  const unsubscribe = Biscuit.subscribe(state => {
    console.log("Updated Biscuit state:", state);
  });

  // 4️⃣ Mutate in-place
  await Biscuit.mutate("user", user => ({ ...user, name: "Kelvin" }));

  // 5️⃣ Remove data
  await Biscuit.remove("user");

  unsubscribe();
}

main();
```

> `Biscuit` (the default export) is a ready-to-use instance. For isolated stores, use `createBiscuit()` — see [Namespaces](#-namespaces) below.

---

## 🗂 Namespaces

Need more than one independent cache (e.g. cart vs. user session)? Each `createBiscuit()` call gets its own in-memory jar and its own IndexedDB database.

```js
import { createBiscuit } from "biscuit-cache-js";

const CartStore = createBiscuit({ namespace: "cart" });
const UserStore = createBiscuit({ namespace: "user" });

await CartStore.set("items", ["Apple", "Banana"]);
await UserStore.set("user", { id: "123", name: "Martins" });
```

---

## ⏱ TTL + Background Refresh
```js
async function fetchFriends() {
  const res = await fetch("/api/friends");
  return res.json();
}

// Cache with 1 hour TTL + auto-refresh using the fetcher
await Biscuit.set("friends", await fetchFriends(), 3_600_000, fetchFriends);
```

Biscuit will:
- Serve data instantly from memory
- Refresh data in the background starting at ~90% of the TTL (10% before expiry)
- Keep all tabs synced automatically

### Refresh policies

Control *when* a key's fetcher runs via the 5th argument to `set()`:

```js
await Biscuit.set(key, value, ttl, fetcher, { refreshPolicy: "on-demand" });
```

| Policy | Behavior |
| --- | --- |
| `"background"` *(default)* | Proactively refreshes before expiry — the key rarely goes stale |
| `"on-demand"` | Never runs ahead of time. Fetches only when the key is actually read after expiring — and `get()` still returns instantly with the stale value while the fetch happens in the background, so reads are never blocked by the network. Pass `{ blocking: true }` to `get()` if a specific read genuinely needs to wait for a fresh value. |
| `"never"` | Fully manual — only an explicit `refresh()` or `invalidate()` call updates it |

---

## 🔄 Cross-Tab Sync

Open two tabs of your app. Updating Biscuit in one tab updates the other automatically — including a full `clear()`.

```js
await Biscuit.set("theme", "dark");
// Other tabs get notified instantly 🎉
```

---

## ♻️ Cache Invalidation

Force a key (or a whole group of keys) to refresh on next access:

```js
await Biscuit.invalidate("friends");           // one key
await Biscuit.invalidatePattern("friends-*");   // wildcard, or pass a RegExp
```

---

## 📚 Batch Operations
```js
await Biscuit.setMany([
  { key: "a", value: 1, ttl: 60_000 },
  { key: "b", value: 2, ttl: 60_000 },
]);

const { a, b } = await Biscuit.getMany(["a", "b"]);
```

---

## ⏳ Waiting for a Value

Resolve as soon as a key has data — immediately if it's already cached, or the first time it's set/refreshed otherwise:

```js
const user = await Biscuit.waitFor("user", { timeout: 5000 });
```

---

## 🛡 Resilience

Biscuit is built to fail safely rather than take your app down with it:

```js
const cache = createBiscuit({
  maxRetries: 2,                                  // retry a failed background refresh
  retryDelay: attempt => Math.min(500 * 2 ** attempt, 10_000), // backoff
  fetchTimeout: 8000,                              // give up waiting on a slow fetcher
  onError: (error, context) => reportToSentry(error, context), // pipe failures to your telemetry
});
```

Fetchers can optionally accept an `AbortSignal` to support real cancellation on timeout or `destroy()`:

```js
const fetchUser = (signal) => fetch("/api/user", { signal }).then(r => r.json());
```

> Cancellation only stops your app from *waiting* on the request — it can't undo something a server already did. If a fetcher wraps a mutation rather than a read, use an idempotency key on your backend so a client-side retry can't double-apply it.

---

## 🖥 Works in Node / SSR

No `indexedDB` or `window`? Biscuit detects this automatically and runs memory-only instead of throwing — safe to import in a Next.js/Node context.

---

## ⚛️ React Hooks (optional)

```js
import { useBiscuit } from "biscuit-cache-js/react";

function Profile() {
  const [user, { loading, refresh }] = useBiscuit(Biscuit, "user:42", {
    fetcher: () => fetchUser(42),
    ttl: 60_000,
  });
  if (loading) return <Spinner />;
  return <div>{user?.name}</div>;
}
```

Requires `react` as a peer dependency — everything else works without it.

---

## 🛠 API Reference

| Method | Description |
| --- | --- |
| `set(key, value, ttl?, fetcher?, options?)` | Store data with optional TTL (ms), background-refresh fetcher, and `{ refreshPolicy }` |
| `get(key, { extend?, staleWhileRevalidate?, blocking? })` | Retrieve data |
| `mutate(key, mutator)` | Safely update an existing value in place |
| `remove(key)` | Delete a single entry |
| `clear()` | Clear **all** entries (propagates to other tabs) |
| `has(key)` | Check if a key exists and is still fresh |
| `keys()` / `size(options?)` | Inspect what's cached |
| `subscribe(fn)` / `subscribeKey(key, fn)` | Listen for changes, returns an unsubscribe function |
| `refresh(key)` | Force-refresh a key now (ignores TTL) |
| `invalidate(key)` / `invalidatePattern(pattern)` | Force a key (or matching keys) to refresh on next access |
| `setMany(items)` / `getMany(keys, options?)` | Batch read/write |
| `waitFor(key, { timeout? })` | Resolve once a key has a value |
| `estimateUsage()` | Best-effort storage usage (`{ usage, quota, percent }`) |
| `registerFetcher(id, fn)` / `getMissingFetcherIds()` | Rebind fetchers after a reload |
| `isOnline()` | Whether Biscuit currently thinks the browser is online |
| `enableDebug()` / `disableDebug()` | Toggle verbose console logging |
| `inspect()` | Dump internal state for debugging |
| `destroy()` | Tear down the instance and free resources |

---

## 💡 Why Biscuit?

Think of Biscuit as localStorage + Reactivity + TTL + Background Refresh.
It removes the pain of:
- Manual cache invalidation
- Re-fetching data too often
- Keeping multiple tabs in sync
- Losing data on page reload

---

## 📂 Examples

See the [`examples/`](./examples) folder for more use cases — basic usage, namespaces, debug logging, and a full feature walkthrough.

---

## 📜 License

MIT © Martins Kelvin
