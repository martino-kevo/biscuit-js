# 🍪 Biscuit.js  

**Memory-first, persistent, reactive browser cache with background refresh & cross-tab sync.**  

---

## ✨ Features
- **Memory-first** – Instant reads from a fast in-memory Map  
- **Persistent** – Falls back to IndexedDB for reload-safe storage  
- **Reactive** – Subscribe to updates for live UI state  
- **TTL & Auto-Expiry** – Data expires automatically after configurable `ttl`  
- **Background Refresh** – Optionally re-fetch data before it goes stale  
- **Cross-Tab Sync** – Stays in sync across browser tabs/windows  
- **Tiny & Dependency-free** – Pure JavaScript, no React or framework lock-in  

---

## 📦 Installation
```sh
npm install biscuit-cache-js

```

**🚀 Quick Start**
```sh
import Biscuit from "@martino-kevo/biscuit-js";

async function main() {
  // 1️⃣ Store data with TTL (5 min default)
  await Biscuit.set("user", { id: 1, name: "Martins" });

  // 2️⃣ Retrieve data
  console.log(Biscuit.get("user")); 
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

**⏱ TTL + Background Refresh**
```sh
async function fetchFriends() {
  const res = await fetch("/api/friends");
  return res.json();
}

// Cache with 1 hour TTL + auto-refresh using the fetcher
await Biscuit.set("friends", await fetchFriends(), 3600_000, fetchFriends);

```


Biscuit will:
Serve data instantly from memory
Refresh data 10% before TTL expiry in the background
Keep all tabs synced automatically


**🔄 Cross-Tab Sync**

Open two tabs of your app.
Updating Biscuit in one tab updates the other automatically.
```sh
await Biscuit.set("theme", "dark");
// Other tabs get notified instantly 🎉

```

**🛠 API Reference**

| Method                            | Description                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| `set(key, value, ttl?, fetcher?)` | Store data with optional TTL (ms) & background refresh fetcher |
| `get(key, { extend? })`           | Retrieve data (optionally extend TTL on read)                  |
| `mutate(key, mutator)`            | Safely update existing value using a mutator function          |
| `remove(key)`                     | Delete a single entry                                          |
| `clear()`                         | Clear **all** entries                                          |
| `subscribe(fn)`                   | Listen for state changes, returns an unsubscribe function      |


**💡 Why Biscuit?**

Think of Biscuit as localStorage + Reactivity + TTL + Background Refresh.
It removes the pain of:
Manual cache invalidation
Re-fetching data too often
Keeping multiple tabs in sync
Losing data on page reload

**📂 Examples**

See the examples/
 folder for more use cases:

Basic usage + Advance

**📜 License**

MIT © Martins Kelvin