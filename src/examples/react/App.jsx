import React, { useEffect, useState } from "react";
import Biscuit from "biscuit-cache-js";

// createBiscuit({
//   onMissingFetchers: async (missingIds) => {
//     for (const id of missingIds) {
//       if (id === "trafficFetcher") {
//         registerFetcher("trafficFetcher", async () => api.getTraffic("I-95:miami"));
//       }
//     }
//   }
// })

export default function App() {
    // subscribe() calls its callback immediately with the current cache
    // snapshot, so this gets populated as soon as the effect below runs —
    // no need (and no way, since get() is async) to resolve it here.
    const [profile, setProfile] = useState(null);

    useEffect(() => {
        const unsubscribe = Biscuit.subscribe(state => {
            setProfile(state.profile);
        });

        Biscuit.set("profile", { name: "Martins" }, 10000);

        return () => unsubscribe();
    }, []);

    return (
        <div>
            <h1>React Biscuit Example</h1>
            <pre>{JSON.stringify(profile, null, 2)}</pre>
        </div>
    );
}
