import { createRootRoute, Outlet } from "@tanstack/react-router";
import { FunnelRunner } from "../runner/funnel-runner";
import { resolveCustomHostSlug } from "./index";

// Resolved once, here, for every route: a request arriving on a
// customer's custom domain has no dashboard session and no `/f/<slug>`
// in its URL — it must render the funnel regardless of which path the
// SPA fallback served (see routes/index.tsx for why /login and every
// other path need this too, not just "/"). `resolveCustomHostSlug` is
// the single lookup; nothing else in the app re-implements it.
export const Route = createRootRoute({
  beforeLoad: async () => {
    const funnelSlug = await resolveCustomHostSlug();
    return { funnelSlug };
  },
  component: RootComponent,
});

function RootComponent() {
  const { funnelSlug } = Route.useRouteContext();
  return (
    <div className="min-h-screen bg-background text-foreground">
      {funnelSlug ? <FunnelRunner slug={funnelSlug} /> : <Outlet />}
    </div>
  );
}
