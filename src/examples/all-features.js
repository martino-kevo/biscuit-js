// examples/all-features.js
import Biscuit from "biscuit-cache-js";

/**
 * Simulates an API call
 */
async function fetchFriends() {
  console.log("📡 Fetching fresh friends from backend...");
  return [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" }
  ];
}

async function main() {
  console.log("🔵 Biscuit Demo Starting...\n");

  // --- 1️⃣ Basic Set + Get ---
  console.log("1️⃣ Setting 'user' in Biscuit");
  await Biscuit.set("user", { id: 123, name: "Martins" });

  console.log("👉 Getting 'user':", await Biscuit.get("user"));

  // --- 2️⃣ Subscription (Reactive UI) ---
  console.log("\n2️⃣ Subscribing to Biscuit updates");
  const unsubscribe = Biscuit.subscribe(state => {
    console.log("📢 Biscuit changed:", state);
  });

  // --- 3️⃣ Mutate (In-place Updates) ---
  console.log("\n3️⃣ Mutating 'user' to change name");
  await Biscuit.mutate("user", user => ({ ...user, name: "Kelvin" }));

  // --- 4️⃣ TTL + Background Refresh ---
  console.log("\n4️⃣ Caching 'friends' with TTL + Background Refresh");
  await Biscuit.set("friends", await fetchFriends(), 5000, fetchFriends);

  console.log("✅ Initial friends from Biscuit:", await Biscuit.get("friends"));

  // Wait 6 seconds to see refresh trigger
  console.log("⏳ Waiting 6s to trigger background refresh...");
  await new Promise(r => setTimeout(r, 6000));
  console.log("✅ Friends after refresh:", await Biscuit.get("friends"));

  // --- 5️⃣ Remove Key ---
  console.log("\n5️⃣ Removing 'user'");
  await Biscuit.remove("user");
  console.log("👉 After remove:", await Biscuit.get("user")); // null

  // --- 6️⃣ Clear Entire Cache ---
  console.log("\n6️⃣ Clearing entire Biscuit jar");
  await Biscuit.clear();

  // --- 7️⃣ Unsubscribe ---
  console.log("\n7️⃣ Unsubscribing from updates");
  unsubscribe();

  console.log("\n🟢 Biscuit Demo Finished!");
}

main();
