import React, { useEffect } from "react";
import Biscuit from "biscuit-cache-js";
import { useBiscuit } from "biscuit-cache-js/react";

export default function App() {
    const [count, { set }] = useBiscuit(Biscuit, "counter", { initialValue: 0 });

    useEffect(() => {
        // mutate() can only update an EXISTING key — it won't create one.
        // Seed "counter" once so the increment button below actually works.
        if (!Biscuit.has("counter")) set(0);
    }, [set]);

    // mutate() isn't exposed through the hook (which is for reading and
    // subscribing), so in-place updates still go through the instance directly.
    const increment = () => Biscuit.mutate("counter", c => (c || 0) + 1);

    return (
        <div>
            <h1>Counter: {count ?? 0}</h1>
            <button onClick={increment}>Increment</button>
        </div>
    );
}
