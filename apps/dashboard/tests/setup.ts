import "@testing-library/jest-dom/vitest";
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
