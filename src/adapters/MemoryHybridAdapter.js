export class MemoryHybridAdapter {
    constructor(adapter) {
        if (!adapter) throw new Error("MemoryHybridAdapter requires a backend adapter");
        this.memory = new Map();
        this.backend = adapter;
    }

    async get(key) {
        if (this.memory.has(key)) return this.memory.get(key);
        const entry = await this.backend.get(key);
        if (entry) this.memory.set(key, entry);
        return entry || null;
    }

    async set(key, entry) {
        this.memory.set(key, entry);
        await this.backend.set(key, entry);
    }

    async delete(key) {
        this.memory.delete(key);
        await this.backend.delete(key);
    }

    async clear() {
        this.memory.clear();
        await this.backend.clear();
    }

    async getAll() {
        const all = await this.backend.getAll();
        all.forEach(e => this.memory.set(e.key, e));
        return Array.from(this.memory.values());
    }
}

// Usage in BiscuitV2 (browser or Node)

// import { createBiscuitV2 } from './BiscuitV2.js';
// import { MemoryHybridAdapter } from './adapters/MemoryHybridAdapter.js';
// import { IndexedDBAdapter } from './adapters/IndexedDBAdapter.js';

// // Use IndexedDB as the backend

// const backendAdapter = new IndexedDBAdapter("my-app-cache");
// const hybridAdapter = new MemoryHybridAdapter(backendAdapter);

// const biscuit = createBiscuitV2({ adapter: hybridAdapter, debug: true });

// // Example usage
// await biscuit.set("user:123", { name: "Alice" }, 10 * 60 * 1000);
// const user = await biscuit.get("user:123");
// console.log(user); // { name: "Alice" }

// ✅ Advantages
// Memory-first caching: ultra-fast reads.
// Backend persistence: survives reloads or server restarts.
// Adapter-agnostic: works with IndexedDB, SQLite, LevelDB, Redis, or any adapter that implements the interface.
// Cross-platform: same BiscuitV2 code for browser, Node.js, or serverless.
// Easy to extend: you can wrap multiple backends or even implement a multi-layered cache.
