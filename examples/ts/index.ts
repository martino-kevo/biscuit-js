import Biscuit from "biscuit-cache-js";

interface Profile {
    name: string;
    age?: number;
}

// Set a value
await Biscuit.set<Profile>("profile", { name: "Martins" }, 10000);

// Get the value
const profile = Biscuit.get<Profile>("profile");
console.log("Profile (TS):", profile);

// Mutate
await Biscuit.mutate<Profile>("profile", current => ({ ...current, age: 25 }));

// Subscribe
Biscuit.subscribe((state: Record<string, any>) => {
    console.log("Biscuit state changed (TS):", state);
});
