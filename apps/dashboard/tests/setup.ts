import "reflect-metadata";
import "@testing-library/jest-dom/vitest";
// Same side-effect import `main.tsx` does. Without it react-i18next has no
// instance in tests, `useTranslation()` warns NO_I18NEXT_INSTANCE, and every
// `t()` renders its raw key — so any assertion written against real copy
// fails while the component is in fact fine. Loading the real config also
// means tests assert against the shipped en.json rather than a fixture that
// can drift from it.
import "../src/i18n/config";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw/server";

// jsdom lacks IntersectionObserver and window.scrollTo. Tests rely on
// neither of them for actual assertions, so stub both to no-ops.
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}
globalThis.IntersectionObserver =
  StubIntersectionObserver as unknown as typeof IntersectionObserver;
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

// Node >= 26 defines its own `localStorage` accessor on `globalThis`, and that
// accessor evaluates to `undefined` (plus an ExperimentalWarning) unless the
// process was started with `--localstorage-file`. vitest's jsdom environment
// copies over only those window keys that are NOT already present on
// `globalThis`, so jsdom's real `localStorage` is skipped and every component
// reading `window.localStorage` sees `undefined`. `sessionStorage` has no
// native Node counterpart, so it is installed normally — the asymmetry is the
// tell. Re-point the key at a Storage-shaped stub so browser code under test
// meets the API a browser actually gives it.
//
// Kept `configurable` on purpose: tests that install their own storage double
// (tests/routes/index-redirect.test.tsx) must still be able to redefine and
// delete it.
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

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: new StubStorage(),
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
