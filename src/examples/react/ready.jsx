import Biscuit from "biscuit-cache-js";
import { useEffect } from "react";

export default function BiscuitCache() {
    useEffect(() => {
        (async () => {
            await Biscuit.ready(); // ✅ wait until IndexedDB is loaded

            if (!Biscuit.has("first_name")) {
                await Biscuit.set("first_name", "SpongeBob");
            }

            console.log("First name:", await Biscuit.get("first_name"));
            console.log("Internal state:", window.__BISCUIT__);
        })();
    }, []);

    return null;
}
