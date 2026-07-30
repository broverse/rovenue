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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
