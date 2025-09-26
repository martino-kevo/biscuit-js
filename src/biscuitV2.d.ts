// biscuitV2.d.ts
export interface StorageAdapter {
  get(key: string): Promise<{ value: any; expiry: number; ttl: number; fetcher?: { fn: () => Promise<any>; id?: string } } | null>;
  set(key: string, entry: { value: any; expiry: number; ttl: number; fetcher?: { fn: () => Promise<any>; id?: string } }): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  getAll(): Promise<Array<{ key: string; value: any; expiry: number; ttl: number; fetcher?: { fn: () => Promise<any>; id?: string } }>>;
}
