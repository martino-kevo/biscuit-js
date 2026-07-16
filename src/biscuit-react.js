// biscuit-react.js
// Optional React bindings for Biscuit. Not required to use Biscuit itself —
// import this only in projects that use React and want reactive hooks
// instead of manually managing subscribe()/subscribeKey().
//
// Usage:
//   import { createBiscuit } from "./biscuit.js";
//   import { useBiscuit, useBiscuitAll } from "./biscuit-react.js";
//
//   const cache = createBiscuit({ namespace: "app" });
//
//   function Profile() {
//     const [user, { loading, refresh }] = useBiscuit(cache, "user:42", {
//       fetcher: () => fetchUser(42),
//       ttl: 60_000,
//     });
//     if (loading) return <Spinner />;
//     return <div>{user?.name}</div>;
//   }

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Subscribe a component to a single Biscuit key.
 *
 * @param {ReturnType<import("./biscuit.js").createBiscuit>} cache
 * @param {string} key
 * @param {{
 *   fetcher?: Function | { id: string, fn: Function },
 *   ttl?: number,
 *   refreshPolicy?: "background" | "on-demand" | "never",
 *   getOptions?: { extend?: boolean, staleWhileRevalidate?: boolean },
 *   initialValue?: any,
 * }} [options]
 * @returns {[value: any, meta: { loading: boolean, error: Error|null, refresh: () => Promise<void>, set: (v:any)=>Promise<void> }]}
 */
export function useBiscuit(cache, key, options = {}) {
  const { fetcher = null, ttl, refreshPolicy, getOptions, initialValue = null } = options;
  const [value, setValue] = useState(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // keep the latest fetcher/ttl/policy in a ref so the effect below doesn't
  // need to re-subscribe every render if the caller passes inline functions
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!cache || !key) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        await cache.ready();
        let current = await cache.get(key, getOptions);
        if (current === null && fetcher) {
          // nothing cached yet — seed it via set(), which also registers
          // the fetcher for future background/on-demand refreshes
          const fresh = await fetcher();
          if (cancelled) return;
          await cache.set(key, fresh, ttl, fetcher, refreshPolicy ? { refreshPolicy } : undefined);
          current = fresh;
        }
        if (!cancelled) {
          setValue(current);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      }
    })();

    const unsubscribe = cache.subscribeKey(key, (v) => {
      if (!cancelled) setValue(v);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key]);

  const refresh = useCallback(() => cache.refresh(key), [cache, key]);
  const set = useCallback((v) => cache.set(key, v, ttl, fetcher), [cache, key, ttl, fetcher]);

  return [value, { loading, error, refresh, set }];
}

/**
 * Subscribe a component to the entire cache contents (global subscribe()).
 * Useful for dev tools / dashboards rather than typical data-fetching UI.
 *
 * @param {ReturnType<import("./biscuit.js").createBiscuit>} cache
 * @returns {Record<string, any>}
 */
export function useBiscuitAll(cache) {
  const [snapshot, setSnapshot] = useState({});

  useEffect(() => {
    if (!cache) return;
    const unsubscribe = cache.subscribe((state) => setSnapshot(state));
    return unsubscribe;
  }, [cache]);

  return snapshot;
}
