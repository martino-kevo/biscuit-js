import Biscuit from "biscuit-cache-js";

(async () => {
    Biscuit.enableDebug(); // ✅ turn on verbose logging
    await Biscuit.ready();

    if (!Biscuit.has("username")) {
        await Biscuit.set("username", "Patrick");
    }

    console.log("From cache:", await Biscuit.get("username"));

    // Later if you want silence
    Biscuit.disableDebug();
})();
