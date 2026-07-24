import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { FunnelRunner } from "../runner/funnel-runner";
import { dashboardHostEnv, isCanonicalDashboardHost } from "../lib/custom-host";
import { resolveCustomHost } from "./index";

// Resolved once, here, for every route: a request arriving on a
// customer's custom domain has no dashboard session and no `/f/<slug>`
// in its URL — it must render the funnel regardless of which path the
// SPA fallback served (see routes/index.tsx for why /login and every
// other path need this too, not just "/"). `resolveCustomHost` is the
// single lookup; nothing else in the app re-implements it.
export const Route = createRootRoute({
  beforeLoad: async () => {
    const { slug, definitive } = await resolveCustomHost();
    const onCanonicalHost =
      typeof window === "undefined" ||
      isCanonicalDashboardHost(dashboardHostEnv, window.location.hostname);
    return { funnelSlug: slug, lookupFailed: !definitive, onCanonicalHost };
  },
  component: RootComponent,
});

function RootComponent() {
  const { funnelSlug, lookupFailed, onCanonicalHost } = Route.useRouteContext();

  if (funnelSlug) return <Shell><FunnelRunner slug={funnelSlug} /></Shell>;

  // The lookup never answered AND we are not on the canonical dashboard
  // host, so this is somebody's own domain pointed at us. Falling through
  // to `<Outlet/>` here would serve Rovenue's login form from a third
  // party's domain — a credential-looking page on DNS we do not own. It
  // is not an auth hole (the session cookie is bound to the canonical
  // origin) but it is the wrong thing to show, and the spec says so.
  //
  // A definitive 404 is different: that host genuinely is not a funnel,
  // so whoever pointed it here gets the dashboard as before.
  if (lookupFailed && !onCanonicalHost) {
    return <Shell><Unavailable /></Shell>;
  }

  return <Shell><Outlet /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">{children}</div>
  );
}

function Unavailable() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="custom-host-unavailable"
      className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <h1 className="text-lg font-medium">{t("customHost.unavailableTitle")}</h1>
      <p className="max-w-md text-sm text-rv-mute-500">
        {t("customHost.unavailableBody")}
      </p>
      <button
        type="button"
        className="mt-2 rounded-md border border-rv-divider px-3 py-1.5 text-sm"
        onClick={() => window.location.reload()}
      >
        {t("customHost.retry")}
      </button>
    </div>
  );
}
