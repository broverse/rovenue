import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus, Webhook } from "lucide-react";
import { Button } from "../../../../ui/button";
import {
  APPS,
  AppCard,
  AppsEmptyState,
  AppsHero,
  AppsSection,
  AppsToolbar,
  BuildYourOwnCard,
  CategoryRail,
  ConnectedStrip,
  FeaturedRecipeBanner,
  HERO_STATS,
  HOMEPAGE_SECTIONS,
  computeCategoryCounts,
  matchesQuery,
  type AppDescriptor,
  type AppTier,
  type AppView,
  type RailEntryId,
} from "../../../../components/apps";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/apps")({
  component: AppsRoute,
});

function AppsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/apps" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AppsPage />;
}

function AppsPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState<RailEntryId>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AppView>("grid");
  const [tier, setTier] = useState<AppTier>("all");

  const counts = useMemo(() => computeCategoryCounts(APPS), []);
  const connected = useMemo(
    () => APPS.filter((app) => app.status === "connected"),
    [],
  );

  const resolveSearchText = (app: AppDescriptor) => [
    t(`apps.items.${app.id}.name`),
    t(`apps.items.${app.id}.description`),
    t(`apps.vendors.${app.vendorKey}`),
    t(`apps.categories.${app.category}`),
  ];

  const filtered = useMemo<ReadonlyArray<AppDescriptor>>(() => {
    return APPS.filter((app) => {
      if (active === "connected" && app.status !== "connected") return false;
      if (active !== "all" && active !== "connected" && app.category !== active) return false;
      return matchesQuery(app, query, resolveSearchText);
    });
    // resolveSearchText recreated each render but t is stable per language;
    // re-running on language change is desirable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, t]);

  const showHomepage = active === "all" && query.trim() === "";

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("apps.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">{t("apps.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("apps.actions.docs")}
          </Button>
          <Button variant="flat" size="sm">
            <Webhook size={13} />
            {t("apps.actions.customWebhook")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("apps.actions.request")}
          </Button>
        </div>
      </header>

      <AppsHero
        totalApps={counts.all}
        connectedApps={counts.connected}
        events={HERO_STATS.events}
        successRate={HERO_STATS.successRate}
      />

      <div className="grid items-start gap-4 grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <CategoryRail active={active} counts={counts} onSelect={setActive} />

        <main className="min-w-0">
          <AppsToolbar
            query={query}
            onQueryChange={setQuery}
            view={view}
            onViewChange={setView}
            tier={tier}
            onTierChange={setTier}
          />

          {showHomepage ? (
            <>
              <FeaturedRecipeBanner />
              <ConnectedStrip apps={connected} />
              {HOMEPAGE_SECTIONS.map((category) => (
                <AppsSection
                  key={category}
                  category={category}
                  apps={APPS.filter((app) => app.category === category).slice(0, 4)}
                  totalCount={counts[category] ?? 0}
                  onViewAll={(next) => setActive(next)}
                />
              ))}
            </>
          ) : (
            <>
              <div className="mt-1 mb-2.5 flex flex-wrap items-baseline gap-2.5">
                <h3 className="text-[14px] font-semibold text-foreground">
                  {query.trim()
                    ? t("apps.results.for", { query: query.trim() })
                    : t(`apps.categories.${active}`)}
                </h3>
                <span className="text-[11.5px] text-rv-mute-500">
                  {t("apps.results.count", { count: filtered.length })}
                </span>
              </div>
              {filtered.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
                  {filtered.map((app) => (
                    <AppCard key={app.id} app={app} />
                  ))}
                </div>
              ) : (
                <AppsEmptyState />
              )}
            </>
          )}

          <BuildYourOwnCard />
        </main>
      </div>
    </>
  );
}
