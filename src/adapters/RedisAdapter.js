// RedisAdapter (Node.js)

class RedisAdapter {
    constructor(redisClient) {
        this.client = redisClient;
    }

    async get(key) {
        const raw = await this.client.get(key);
        return raw ? JSON.parse(raw) : null;
    }

    async set(key, entry) {
        await this.client.set(key, JSON.stringify(entry));
    }

    async delete(key) {
        await this.client.del(key);
    }

    async clear() {
        // Warning: only use in safe environments!
        await this.client.flushDb();
    }

    async getAll() {
        const keys = await this.client.keys('*');
        const entries = [];
        for (const k of keys) {
            const val = await this.client.get(k);
            if (val) entries.push({ key: k, ...JSON.parse(val) });
        }
        return entries;
    }
}

// How to use:
// const biscuit = createBiscuit({ adapter: new RedisAdapter(redisClient) });
// await biscuit.set("foo", { hello: "world" }, 60000);