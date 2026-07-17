import Biscuit from "biscuit-cache-js";
import { useEffect } from "react";

export default function BiscuitCache() {
    useEffect(() => {
        (async () => {
            await Biscuit.ready(); // waits for IndexedDB — a no-op in memory-only/SSR environments

            if (!Biscuit.has("first_name")) {
                await Biscuit.set("first_name", "SpongeBob");
            }

            console.log("First name:", await Biscuit.get("first_name"));
            console.log("Internal state:", window.__BISCUIT__);

            // Note: a fetcher attached as a persistable { id, fn } pair survives
            // a reload as a fetcherId in IndexedDB, but the function itself can't
            // be serialized. Use createBiscuit({ onMissingFetchers }) together
            // with registerFetcher() to rebind fetchers after a fresh page load.
        })();
    }, []);

    return null;
}
