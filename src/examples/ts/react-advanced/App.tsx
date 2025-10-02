// import React, { useEffect, useState } from "react";
// import Biscuit from "../../../src/biscuit.js";

// interface Profile {
//     name: string;
//     age?: number;
// }

// interface Settings {
//     theme: string;
//     notifications: boolean;
// }

// export default function App() {
//     const [profile, setProfile] = useState<Profile | null>(Biscuit.get<Profile>("profile"));
//     const [settings, setSettings] = useState<Settings | null>(Biscuit.get<Settings>("settings"));
//     const [cacheState, setCacheState] = useState<Record<string, any>>({});

//     useEffect(() => {
//         // --- 1. Subscribe to all changes ---
//         const unsubscribe = Biscuit.subscribe(state => {
//             setCacheState(state);
//             setProfile(state.profile ?? null);
//             setSettings(state.settings ?? null);
//         });

//         // --- 2. Set profile with TTL 10s and background refresh ---
//         Biscuit.set<Profile>(
//             "profile",
//             { name: "Martins", age: 25 },
//             10000,
//             async () => {
//                 // Simulate API call
//                 console.log("Refreshing profile...");
//                 return { name: "Martins", age: Math.floor(Math.random() * 50) };
//             }
//         );

//         // --- 3. Set settings key ---
//         Biscuit.set<Settings>("settings", { theme: "dark", notifications: true }, 20000);

//         // --- 4. Mutate profile after 5s ---
//         const mutateTimeout = setTimeout(() => {
//             Biscuit.mutate<Profile>("profile", current => ({
//                 ...current,
//                 age: (current.age ?? 0) + 1
//             }));
//         }, 5000);

//         // --- 5. Remove profile after 15s ---
//         const removeTimeout = setTimeout(() => {
//             Biscuit.remove("profile");
//         }, 15000);

//         // --- 6. Clear all after 25s ---
//         const clearTimeoutId = setTimeout(() => {
//             Biscuit.clear();
//         }, 25000);

//         // --- 7. Cleanup ---
//         return () => {
//             unsubscribe();
//             clearTimeout(mutateTimeout);
//             clearTimeout(removeTimeout);
//             clearTimeout(clearTimeoutId);
//         };
//     }, []);

//     return (
//         <div style={{ fontFamily: "sans-serif", padding: 20 }}>
//             <h1>Advanced Biscuit + React Example</h1>

//             <section>
//                 <h2>Profile</h2>
//                 <pre>{JSON.stringify(profile, null, 2)}</pre>
//             </section>

//             <section>
//                 <h2>Settings</h2>
//                 <pre>{JSON.stringify(settings, null, 2)}</pre>
//             </section>

//             <section>
//                 <h2>Full Cache State</h2>
//                 <pre>{JSON.stringify(cacheState, null, 2)}</pre>
//             </section>
//         </div>
//     );
// }
