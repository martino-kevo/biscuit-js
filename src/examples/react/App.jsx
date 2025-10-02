import React, { useEffect, useState } from "react";
import Biscuit from "biscuit-cache-js";

export default function App() {
    const [profile, setProfile] = useState(Biscuit.get("profile"));

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
