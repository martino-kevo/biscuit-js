// examples/react-demo.jsx
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBiscuit } from "biscuit-cache-js";
import { useBiscuitAll } from "biscuit-cache-js/react";

// A dedicated, configured instance (rather than the default `Biscuit`
// singleton) so we can demonstrate the resilience options: retries, a
// fetch timeout, and an onError hook a real app would pipe into telemetry.
const cache = createBiscuit({
  namespace: "react-demo",
  maxRetries: 1,
  fetchTimeout: 8000,
  onError: (error, context) => console.warn("[biscuit]", context, error),
});

// Fetchers can optionally accept an AbortSignal for real cancellation on
// fetchTimeout/destroy() — e.g. fetch(url, { signal }) would use it directly.
async function fetchFriends(signal) {
  console.log("📡 Fetching friends from backend...");
  return [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
    { id: 3, name: "Charlie" }
  ];
}

function App() {
  const state = useBiscuitAll(cache); // replaces manual subscribe() + useState
  const [waiting, setWaiting] = useState(false);
  const friends = state.friends || [];

  useEffect(() => {
    (async () => {
      if (!cache.has("friends")) {
        // "on-demand": only fetches when read after expiry — and get()
        // never blocks on the network even then, it returns stale instantly.
        await cache.set("friends", await fetchFriends(), 10000, fetchFriends, {
          refreshPolicy: "on-demand"
        });
      }
    })();
  }, []);

  const waitForFriends = async () => {
    setWaiting(true);
    await cache.waitFor("friends", { timeout: 5000 }).catch(() => {});
    setWaiting(false);
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>🍪 Biscuit React Demo</h1>
      <p>
        <strong>Stored Keys:</strong> {cache.keys().join(", ") || "None"}
        <br />
        <strong>Total Items:</strong> {cache.size()}
      </p>

      <h2>Friends</h2>
      <ul>
        {friends.length > 0 ? (
          friends.map(f => <li key={f.id}>{f.name}</li>)
        ) : (
          <li>{waiting ? "Waiting..." : "Loading..."}</li>
        )}
      </ul>

      <button onClick={() => cache.refresh("friends")}>🔄 Refresh Friends</button>
      <button style={{ marginLeft: 8 }} onClick={() => cache.invalidate("friends")}>
        ♻️ Invalidate (triggers refetch)
      </button>
      <button
        style={{ marginLeft: 8 }}
        onClick={() => cache.mutate("friends", list => list.filter(f => f.id !== 1))}
      >
        ❌ Remove Alice
      </button>
      <button style={{ marginLeft: 8 }} onClick={waitForFriends}>
        ⏳ waitFor("friends")
      </button>
      <button style={{ marginLeft: 8 }} onClick={() => cache.clear()}>
        🗑 Clear Biscuit
      </button>

      <pre style={{ background: "#f4f4f4", padding: 8, marginTop: 16 }}>
        {JSON.stringify(state, null, 2)}
      </pre>
    </div>
  );
}

// Render to DOM
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);


// ✅ What this Example Covers

// ✔ createBiscuit() with resilience config (maxRetries, fetchTimeout, onError)
// ✔ useBiscuitAll() — reactive full-state hook instead of manual subscribe()
// ✔ set() with refreshPolicy: "on-demand" — lazy, never-blocking refresh
// ✔ has() (only fetch if missing)
// ✔ keys() + size() (cache introspection)
// ✔ refresh(key) (manual background fetch)
// ✔ invalidate(key) (force a refetch)
// ✔ mutate() (optimistically remove a friend)
// ✔ waitFor(key) (resolve once data is available)
// ✔ clear() (wipe all cached data)
// ✔ AbortSignal-aware fetcher signature (fetchFriends(signal))
