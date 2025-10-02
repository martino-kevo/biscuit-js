// import React, { useEffect, useState } from "react";
// import Biscuit from "./biscuit-cache-js";

// export default function App() {
//   const [user, setUser] = useState<{ name: string } | null>(null);

//   useEffect(() => {
//     const unsubscribe = Biscuit.subscribe(state => {
//       if (state.user) setUser(state.user as { name: string });
//     });

//     return () => unsubscribe();
//   }, []);

//   const saveUser = async () => {
//     await Biscuit.set("user", { name: "Martins" }, 10_000);
//   };

//   return (
//     <div>
//       <h1>Hello {user?.name ?? "Guest"}</h1>
//       <button onClick={saveUser}>Set User</button>
//     </div>
//   );
// }
