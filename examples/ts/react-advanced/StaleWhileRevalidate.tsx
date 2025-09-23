// import React, { useEffect, useState } from "react";
// import Biscuit from "./biscuit-cache-js";

// interface User {
//     id: string;
//     name: string;
// }

// export default function App() {
//     const [user, setUser] = useState<User | null>(null);

//     useEffect(() => {
//         const fetchUser = async (): Promise<User> => {
//             console.log("Fetching fresh user...");
//             const res = await fetch("/api/user");
//             return res.json();
//         };

//         Biscuit.set<User>("user", { id: "0", name: "Loading..." }, 5000, fetchUser);

//         const unsubscribe = Biscuit.subscribe(state => {
//             if (state.user) setUser(state.user as User);
//         });

//         return () => unsubscribe();
//     }, []);

//     const getUser = () => {
//         const cached = Biscuit.get<User>("user", { staleWhileRevalidate: true });
//         console.log("Cached user:", cached);
//     };

//     return (
//         <div>
//             <h1>User: {user?.name ?? "No user"}</h1>
//             <button onClick={getUser}>Load User (stale-while-revalidate)</button>
//         </div>
//     );
// }
