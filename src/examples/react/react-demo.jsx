// examples/react-demo.jsx
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Biscuit from "biscuit-cache-js";

async function fetchFriends() {
  console.log("📡 Fetching friends from backend...");
  return [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
    { id: 3, name: "Charlie" }
  ];
}

function App() {
  const [state, setState] = useState({});

  useEffect(() => {
    const unsubscribe = Biscuit.subscribe(setState);

    // Preload friends with TTL + fetcher
    (async () => {
      if (!Biscuit.has("friends")) {
        await Biscuit.set("friends", await fetchFriends(), 10000, fetchFriends);
      }
    })();

    return unsubscribe;
  }, []);

  const friends = state.friends || [];

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>🍪 Biscuit React Demo</h1>
      <p>
        <strong>Stored Keys:</strong> {Biscuit.keys().join(", ") || "None"}
        <br />
        <strong>Total Items:</strong> {Biscuit.size()}
      </p>

      <h2>Friends</h2>
      <ul>
        {friends.length > 0 ? (
          friends.map(f => <li key={f.id}>{f.name}</li>)
        ) : (
          <li>Loading...</li>
        )}
      </ul>

      <button onClick={() => Biscuit.refresh("friends")}>🔄 Refresh Friends</button>
      <button
        style={{ marginLeft: 8 }}
        onClick={() => Biscuit.mutate("friends", list => list.filter(f => f.id !== 1))}
      >
        ❌ Remove Alice
      </button>

      <button
        style={{ marginLeft: 8 }}
        onClick={() => Biscuit.clear()}
      >
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

// ✔ set() + get() (preloads friends)
// ✔ subscribe() (state updates automatically when Biscuit changes)
// ✔ has() (only fetch if missing)
// ✔ keys() + size() (shows current cache info)
// ✔ refresh(key) (manual background fetch)
// ✔ mutate() (optimistically remove a friend)
// ✔ clear() (wipe all cached data)