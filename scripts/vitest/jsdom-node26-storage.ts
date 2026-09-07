// Restores `localStorage` under vitest's jsdom environment on Node >= 26.
//
// Node >= 26 defines its own `localStorage` accessor on `globalThis`, and that
// accessor evaluates to `undefined` (plus an ExperimentalWarning) unless the
// process was started with `--localstorage-file`. vitest's jsdom environment
// copies over only those window keys that are NOT already present on
// `globalThis`, so jsdom's real `localStorage` is skipped for being "already
// there" and every component reading `window.localStorage` sees `undefined`.
//
// `sessionStorage` has no native Node counterpart, so it installs normally —
// that asymmetry (same file, same environment, one storage API present and the
// other not) is the tell that this is an install-time key collision rather than
// anything about the code under test.
//
// Shared rather than duplicated: `apps/dashboard` and `packages/paywall-renderer`
// are the only two jsdom vitest projects in this repo, and both hit it. It lives
// under `scripts/` rather than in `@rovenue/shared` deliberately — this is test
// scaffolding and has no business in a published package's export surface.
//
// `configurable` is kept on purpose: tests that install their own storage double
// (apps/dashboard/tests/routes/index-redirect.test.tsx) must still be able to
// redefine and delete it.

class StubStorage implements Storage {
  #entries = new Map<string, string>();

  get length() {
    return this.#entries.size;
  }
  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    const value = this.#entries.get(String(key));
    return value === undefined ? null : value;
  }
  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }
  clear(): void {
    this.#entries.clear();
  }
}

export function installJsdomStorageIfMissing(): void {
  if (globalThis.localStorage) return;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: new StubStorage(),
  });
}

installJsdomStorageIfMissing();
