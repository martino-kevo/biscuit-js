import React, { useEffect, useState } from "react";
import Biscuit from "biscuit-cache-js";

export default function App() {
    const [count, setCount] = useState(0);

    useEffect(() => {
        // Subscribe to Biscuit changes
        const unsubscribe = Biscuit.subscribe(state => {
            console.log("Biscuit state changed:", state);
            setCount(state.counter || 0);
        });

        // mutate() can only update an EXISTING key — it won't create one.
        // Seed "counter" first so the increment button below actually works.
        (async () => {
            if (!Biscuit.has("counter")) {
                await Biscuit.set("counter", 0);
            }
        })();

        return () => unsubscribe();
    }, []);

    const increment = async () => {
        await Biscuit.mutate("counter", c => (c || 0) + 1);
    };

    return (
        <div>
            <h1>Counter: {count}</h1>
            <button onClick={increment}>Increment</button>
        </div>
    );
}
