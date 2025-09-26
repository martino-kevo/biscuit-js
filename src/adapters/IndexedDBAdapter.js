// IndexedDBAdapter for BiscuitV2
export class IndexedDBAdapter {
    constructor(dbName = "biscuitV2-store") {
        this.dbName = dbName;
        this.storeName = "biscuitV2-jar";
        this.db = null;
    }

    async openDB() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const _db = e.target.result;
                if (!_db.objectStoreNames.contains(this.storeName)) {
                    _db.createObjectStore(this.storeName, { keyPath: "key" });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async get(key) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readonly");
            const req = tx.objectStore(this.storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async set(key, entry) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readwrite");
            const req = tx.objectStore(this.storeName).put({ key, ...entry });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async delete(key) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readwrite");
            const req = tx.objectStore(this.storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async clear() {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readwrite");
            const req = tx.objectStore(this.storeName).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async getAll() {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readonly");
            const req = tx.objectStore(this.storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }
}
