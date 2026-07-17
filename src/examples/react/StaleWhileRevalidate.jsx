import React, { useEffect, useState } from "react";
import Biscuit from "biscuit-cache-js";

export default function App() {
    const [user, setUser] = useState(null);

    useEffect(() => {
        const fetchUser = async (signal) => {
            console.log("Fetching fresh user...");
            const res = await fetch("/api/user", { signal });
            return res.json();
        };

        // refreshPolicy: "on-demand" — nothing fetches until "user" is
        // actually read after expiring, and even then get() never blocks:
        // it returns the stale value immediately and refreshes in the
        // background. This is Biscuit's built-in stale-while-revalidate.
        Biscuit.set("user", { name: "Loading..." }, 5000, fetchUser, {
            refreshPolicy: "on-demand"
        });

        const unsubscribe = Biscuit.subscribe(state => {
            setUser(state.user);
        });

        return () => unsubscribe();
    }, []);

    const getUser = async () => {
        // Non-blocking (default): returns stale instantly, refreshes behind it.
        const cached = await Biscuit.get("user");
        console.log("Cached user (non-blocking):", cached);
    };

    const getUserFresh = async () => {
        // Explicit opt-in for the rare case where staleness is a real bug —
        // e.g. re-checking a permission right before a sensitive action.
        // This DOES wait for the network.
        const fresh = await Biscuit.get("user", { blocking: true });
        console.log("Fresh user (blocking):", fresh);
    };

    return (
        <div>
            <h1>User: {user?.name ?? "No user"}</h1>
            <button onClick={getUser}>Load User (non-blocking, default)</button>
            <button onClick={getUserFresh} style={{ marginLeft: 8 }}>
                Load User (blocking, guarantees freshness)
            </button>
        </div>
    );
}
