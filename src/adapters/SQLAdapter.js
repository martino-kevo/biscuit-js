// SQLAdapter (SQLite / Postgres)

class SQLAdapter {
    constructor(db) { this.db = db; }

    async get(key) {
        const row = await this.db.get('SELECT * FROM cache WHERE key=?', key);
        return row ? { value: JSON.parse(row.value), expiry: row.expiry, ttl: row.ttl } : null;
    }

    async set(key, entry) {
        await this.db.run(
            'INSERT INTO cache(key, value, expiry, ttl) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=?, expiry=?, ttl=?',
            key, JSON.stringify(entry.value), entry.expiry, entry.ttl,
            JSON.stringify(entry.value), entry.expiry, entry.ttl
        );
    }

    async delete(key) {
        await this.db.run('DELETE FROM cache WHERE key=?', key);
    }

    async clear() {
        await this.db.run('DELETE FROM cache');
    }

    async getAll() {
        const rows = await this.db.all('SELECT * FROM cache');
        return rows.map(r => ({ key: r.key, value: JSON.parse(r.value), expiry: r.expiry, ttl: r.ttl }));
    }
}
