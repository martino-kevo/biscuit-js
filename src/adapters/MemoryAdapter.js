export class MemoryAdapter {
    constructor() { this.store = new Map(); }
    async get(key) { return this.store.get(key) || null; }
    async set(key, entry) { this.store.set(key, entry); }
    async delete(key) { this.store.delete(key); }
    async clear() { this.store.clear(); }
    async getAll() { return Array.from(this.store.entries()).map(([key, value]) => ({ key, ...value })); }
}