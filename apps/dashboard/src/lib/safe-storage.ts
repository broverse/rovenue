// Every `localStorage` access in the dashboard goes through here.
//
// Two distinct hazards, and the obvious guard only covers one of them:
//
//  1. No `localStorage` at all — SSR, and vitest+jsdom on Node >= 26 (see
//     scripts/vitest/jsdom-node26-storage.ts). A `typeof` check covers this.
//  2. A browser with site data blocked. There `localStorage` is DEFINED but
//     touching it throws `SecurityError` — so `typeof localStorage !== "undefined"`
//     passes and the very next access still throws. Only try/catch covers it.
//
// Hazard 2 is why this file exists. `RoviProvider` read storage unguarded in a
// `useState` initialiser, and it sits high in the tree — so a reader with site
// data blocked got a white-screened dashboard, not a degraded one. Persisted UI
// preferences are conveniences; failing to read one must never take the page
// down with it.

export function readStoredValue(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Ignored on purpose: see the note above.
  }
}

export function removeStoredValue(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    // Ignored on purpose: see the note above.
  }
}
