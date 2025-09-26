import { IndexedDBAdapter } from './IndexedDBAdapter.js';

export class MemoryIndexedDBAdapter {
    constructor(dbName = "biscuitV2-store") {
        this.memory = new Map();
        this.persistent = new IndexedDBAdapter(dbName);
    }

    async get(key) {
        if (this.memory.has(key)) {
            return this.memory.get(key);
        }
        const entry = await this.persistent.get(key);
        if (entry) this.memory.set(key, entry);
        return entry || null;
    }

    async set(key, entry) {
        this.memory.set(key, entry);
        await this.persistent.set(key, entry);
    }

    async delete(key) {
        this.memory.delete(key);
        await this.persistent.delete(key);
    }

    async clear() {
        this.memory.clear();
        await this.persistent.clear();
    }

    async getAll() {
        const all = await this.persistent.getAll();
        all.forEach(e => this.memory.set(e.key, e));
        return Array.from(this.memory.values());
    }
}
