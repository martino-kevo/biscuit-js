import React from "react";
import Biscuit from "biscuit-cache-js";
import { useBiscuit } from "biscuit-cache-js/react";

export default function App() {
    // useBiscuit reads "profile", seeds it via the fetcher if it's missing,
    // and stays in sync with future updates automatically — no manual
    // subscribe()/useEffect wiring needed.
    const [profile, { loading }] = useBiscuit(Biscuit, "profile", {
        fetcher: async () => ({ name: "Martins" }),
        ttl: 10000,
    });

    return (
        <div>
            <h1>React Biscuit Example</h1>
            {loading ? <p>Loading…</p> : <pre>{JSON.stringify(profile, null, 2)}</pre>}
        </div>
    );
}
