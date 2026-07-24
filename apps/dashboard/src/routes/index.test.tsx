import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { I18nProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
  redirect as redirectImport,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { server } from "../../tests/msw/server";
import { API_BASE_URL } from "../lib/api";
import { queryClient } from "../lib/queryClient";
import { Route as RootRouteImport } from "./__root";
import { Route as IndexRouteImport } from "./index";
import { Route as LoginRouteImport } from "./login";
// initialise i18n so login.tsx's email placeholder renders real copy
// instead of the raw translation key.
import "../i18n/config";

// =============================================================
// Custom-domain funnel serving — routes/index.tsx + __root.tsx
// =============================================================
//
// Before this change, `routes/index.tsx` always redirected to /login
// when there was no dashboard session, so a funnel visitor arriving on
// a customer's custom domain landed on a Rovenue login screen. These
// tests exercise the REAL root + "/" + "/login" file routes assembled
// into a router the same way `routeTree.gen.ts` does (`addChildren`),
// so a regression in the actual beforeLoad/branch logic fails here —
// not a hand-rolled stand-in for it.

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, redirect: vi.fn(actual.redirect) };
});

vi.mock("../runner/funnel-runner", () => ({
  FunnelRunner: ({ slug }: { slug: string }) => (
    <div data-testid="mock-funnel-runner">{slug}</div>
  ),
}));

// Better Auth's client (`@better-fetch/fetch`) throws in this
// jsdom+undici test environment on a real network round trip
// ("Expected signal to be an instance of AbortSignal" — a pre-existing
// cross-realm AbortSignal mismatch, reproducible on main independent
// of this change). These tests are about the custom-host branch, not
// session mechanics, so the session boundary is mocked directly; the
// real beforeLoad code that reads `session.data` still runs.
vi.mock("../lib/auth", () => ({
  getSession: vi.fn(async () => ({ data: null as { user: unknown } | null })),
}));

// `dashboardHostEnv` is derived from `import.meta.env` at module load,
// same idiom as lib/host-mode.ts — swap it for a mutable test double so
// each test can drive `isCanonicalDashboardHost` (kept real) without
// stubbing `import.meta.env`.
const hostEnv = vi.hoisted<{ VITE_DASHBOARD_HOST?: string }>(() => ({}));
vi.mock("../lib/custom-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/custom-host")>();
  return { ...actual, dashboardHostEnv: hostEnv };
});

// Real copy from i18n/locales/en.json's auth.signIn.emailPlaceholder —
// a genuine selector into login.tsx's markup, not an invented test id.
const EMAIL_PLACEHOLDER = "you@company.com";

function setHostname(hostname: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true,
  });
}

function renderApp(initialPath: string) {
  // `createFileRoute()` binds each route to an internal placeholder
  // root until something rewires `getParentRoute` onto the real one —
  // normally routeTree.gen.ts's generated `.update({...})` calls. This
  // mirrors that exact wiring for the two file routes under test.
  const indexRoute = IndexRouteImport.update({
    id: "/",
    path: "/",
    getParentRoute: () => RootRouteImport,
  } as never);
  const loginRoute = LoginRouteImport.update({
    id: "/login",
    path: "/login",
    getParentRoute: () => RootRouteImport,
  } as never);
  const routeTree = RootRouteImport.addChildren([indexRoute, loginRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return rtlRender(
    <I18nProvider>
      <QueryClientProvider client={testQueryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("custom-domain funnel serving", () => {
  const redirectMock = vi.mocked(redirectImport);

  beforeEach(() => {
    queryClient.clear();
    redirectMock.mockClear();
    hostEnv.VITE_DASHBOARD_HOST = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the funnel runner on a host that resolves", async () => {
    setHostname("quiz.acme.com");
    hostEnv.VITE_DASHBOARD_HOST = "app.rovenue.io";
    const lookupMock = vi.fn();
    server.use(
      http.get(`${API_BASE_URL}/public/host/lookup`, ({ request }) => {
        lookupMock();
        const host = new URL(request.url).searchParams.get("host");
        if (host === "quiz.acme.com") {
          return HttpResponse.json({
            data: { funnelId: "fun_1", slug: "quiz" },
          });
        }
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Unknown host" } },
          { status: 404 },
        );
      }),
    );

    renderApp("/");

    expect(await screen.findByTestId("mock-funnel-runner")).toBeTruthy();
    expect(lookupMock).toHaveBeenCalled();
    // The bug being fixed: a funnel visitor must not be bounced to login.
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("keeps the dashboard landing behaviour on the canonical host", async () => {
    setHostname("app.rovenue.io");
    hostEnv.VITE_DASHBOARD_HOST = "app.rovenue.io";
    const lookupMock = vi.fn();
    server.use(
      http.get(`${API_BASE_URL}/public/host/lookup`, () => {
        lookupMock();
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Unknown host" } },
          { status: 404 },
        );
      }),
    );

    renderApp("/");

    // No session + canonical host -> beforeLoad's existing redirect
    // fires and the router settles on /login. Waiting for that real
    // login markup is the non-vacuous proof the redirect actually ran.
    await screen.findByPlaceholderText(EMAIL_PLACEHOLDER);
    expect(screen.queryByTestId("mock-funnel-runner")).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("keeps the dashboard landing behaviour when the host resolves to nothing", async () => {
    setHostname("quiz.acme.com");
    hostEnv.VITE_DASHBOARD_HOST = "app.rovenue.io";
    server.use(
      http.get(`${API_BASE_URL}/public/host/lookup`, () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Unknown host" } },
          { status: 404 },
        ),
      ),
    );

    renderApp("/");

    await screen.findByPlaceholderText(EMAIL_PLACEHOLDER);
    expect(screen.queryByTestId("mock-funnel-runner")).toBeNull();
  });

  it("renders the funnel runner for a non-root path on a resolving host", async () => {
    setHostname("quiz.acme.com");
    hostEnv.VITE_DASHBOARD_HOST = "app.rovenue.io";
    server.use(
      http.get(`${API_BASE_URL}/public/host/lookup`, () =>
        HttpResponse.json({ data: { funnelId: "fun_1", slug: "quiz" } }),
      ),
    );

    renderApp("/login");

    expect(await screen.findByTestId("mock-funnel-runner")).toBeTruthy();
    expect(screen.queryByPlaceholderText(EMAIL_PLACEHOLDER)).toBeNull();
  });

  it("still renders the login form on the canonical host", async () => {
    setHostname("app.rovenue.io");
    hostEnv.VITE_DASHBOARD_HOST = "app.rovenue.io";

    renderApp("/login");

    expect(await screen.findByPlaceholderText(EMAIL_PLACEHOLDER)).toBeTruthy();
  });
});
