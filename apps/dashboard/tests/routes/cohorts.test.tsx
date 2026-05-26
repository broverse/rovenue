import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { Route } from "../../src/routes/_authed/projects/$projectId/cohorts";

const BASE = "http://localhost:3000";
void BASE; // used implicitly by MSW handlers registered globally

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  }
});

/**
 * Renders the cohorts route at a given initial path using a dedicated
 * mini-router. The route is registered at exactly the path the component
 * expects so that `useParams({ from: "/_authed/projects/$projectId/cohorts" })`
 * and `useSearch({ from: ... })` resolve correctly.
 */
async function renderRoute(initialPath: string) {
  const Component = Route.options.component!;
  const rootRoute = createRootRoute({ component: Outlet });
  const cohortsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/_authed/projects/$projectId/cohorts",
    component: Component,
    validateSearch: Route.options.validateSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([cohortsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, router };
}

describe("cohorts route", () => {
  test("renders the cohort name returned by the API", async () => {
    await renderRoute("/_authed/projects/proj_1/cohorts");
    // "High-value users" appears in multiple places (rail, hero, heatmap header)
    await waitFor(() =>
      expect(screen.getAllByText("High-value users").length).toBeGreaterThan(0),
    );
  });

  test("renders hero size and W4 retention from the retention response", async () => {
    await renderRoute("/_authed/projects/proj_1/cohorts");
    // size: 4821 → "4,821" (toLocaleString), w4: points[4].pct=62.4 → "62.4%"
    await waitFor(() =>
      expect(screen.getAllByText(/4[,.]?821/).length).toBeGreaterThan(0),
    );
    // 62.4% appears in the hero stat and in the heatmap cell — both are correct
    await waitFor(() =>
      expect(screen.getAllByText(/62\.4%/).length).toBeGreaterThan(0),
    );
  });

  test("clicking New cohort navigates to /cohorts/new path", async () => {
    const { router } = await renderRoute("/_authed/projects/proj_1/cohorts");
    // Wait for the page to fully render (cohort data loaded)
    await waitFor(() =>
      expect(screen.getAllByText("High-value users").length).toBeGreaterThan(0),
    );
    // Find all "New cohort" buttons and click the first (header button)
    const buttons = screen.getAllByText(/new cohort/i);
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(router.state.location.pathname).toContain("cohorts/new");
    });
  });
});
