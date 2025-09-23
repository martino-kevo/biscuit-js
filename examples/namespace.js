import { createBiscuit } from "./biscuit-cache-js";

// Create isolated stores
const CartStore = createBiscuit({ namespace: "cart" });
const UserStore = createBiscuit({ namespace: "user" });

async function demo() {
    await CartStore.set("items", ["Apple", "Banana"]);
    await UserStore.set("user", { id: "123", name: "Martins" });

    console.log("Cart items:", CartStore.get("items")); // ["Apple", "Banana"]
    console.log("User info:", UserStore.get("user"));   // { id: "123", name: "Martins" }

    CartStore.subscribe(state => console.log("Cart changed:", state));
    UserStore.subscribe(state => console.log("User changed:", state));
}
demo();
