import type { ReactElement } from "react";
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
import { render as rtlRender } from "@testing-library/react";

/**
 * Renders `ui` at `initialPath` inside TanStack Router memory
 * history, a fresh QueryClient (no retries), and HeroUI's I18n
 * provider. The UI is registered at a catch-all `$` route so any
 * `initialPath` matches. For route components that call hooks
 * such as `Route.useSearch()` or `useParams({ from: ... })` on
 * their own file-route id, this helper won't satisfy those hooks
 * — use `renderWithRouteTree` for those cases.
 */
export function renderWithRouter(ui: ReactElement, initialPath = "/") {
  const rootRoute = createRootRoute({ component: Outlet });
  const splat = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => ui,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, splat]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return rtlRender(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
