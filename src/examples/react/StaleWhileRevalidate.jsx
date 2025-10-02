import React, { useEffect, useState } from "react";
import Biscuit from "biscuit-cache-js";

export default function App() {
    const [user, setUser] = useState(null);

    useEffect(() => {
        // Register a fetcher for background refresh
        const fetchUser = async () => {
            console.log("Fetching fresh user...");
            const res = await fetch("/api/user");
            return res.json();
        };

        // Initial set with TTL 5s + fetcher for refresh
        Biscuit.set("user", { name: "Loading..." }, 5000, fetchUser);

        // Subscribe to changes
        const unsubscribe = Biscuit.subscribe(state => {
            setUser(state.user);
        });

        return () => unsubscribe();
    }, []);

    const getUser = async () => {
        // Even if expired, returns stale value first, then refreshes in background
        const cached = await Biscuit.get("user", { staleWhileRevalidate: true });
        console.log("Cached user:", cached);
    };

    return (
        <div>
            <h1>User: {user?.name ?? "No user"}</h1>
            <button onClick={getUser}>Load User (stale-while-revalidate)</button>
        </div>
    );
}
