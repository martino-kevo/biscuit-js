import Biscuit from "biscuit-js";

async function main() {
  await Biscuit.set("user", { id: 1, name: "Martins" });
  console.log("User:", Biscuit.get("user"));

  const unsubscribe = Biscuit.subscribe(state => {
    console.log("Biscuit updated:", state);
  });

  await Biscuit.mutate("user", user => ({ ...user, name: "Kelvin" }));
  unsubscribe();
}

main();
