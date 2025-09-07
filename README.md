# Biscuit.js

Chewy, persistent, reactive browser cache with background refresh and cross-tab sync.

## Features

- Memory-first cache → instant reads
- IndexedDB persistence
- TTL & sticky expiry
- Background refresh (stale-while-revalidate)
- Cross-tab sync → updates propagate across all tabs
- Reactive subscriptions → UI auto-updates
- TypeScript support included

## Installation

```bash
npm install biscuit-js


**Usage**

import Biscuit from "biscuit-js";

// Set a biscuit
await Biscuit.set("profile", { name: "Martins" }, 60000);

// Get it
console.log(Biscuit.get("profile"));

// Subscribe to changes
Biscuit.subscribe(state => console.log("Biscuit changed:", state));

// Background refresh
await Biscuit.set("profile", await fetchProfile(), 60000, fetchProfile);

