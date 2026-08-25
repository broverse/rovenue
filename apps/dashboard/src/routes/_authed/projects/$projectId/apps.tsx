import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Webhook } from "lucide-react";
import type { IntegrationProviderId } from "@rovenue/shared";
import { Button, buttonVariants } from "../../../../ui/button";
import {
  APPS,
  AppCard,
  AppsEmptyState,
  AppsHero,
  AppsSection,
  AppsToolbar,
  BuildYourOwnCard,
  CategoryRail,
  ConfiguredWebhookCard,
  ConnectedStrip,
  CUSTOM_WEBHOOK_APP_ID,
  DOCS_URL,
  HOMEPAGE_SECTIONS,
  computeCategoryCounts,
  matchesQuery,
  type AppDescriptor,
  type RailEntryId,
  type WebhookCardBundle,
} from "../../../../components/apps";
import { IntegrationDrawer } from "../../../../components/apps/integration-drawer/integration-drawer";
import { CustomWebhookModal } from "../../../../components/apps/custom-webhook-modal";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectAppConnections } from "../../../../lib/hooks/useProjectAppConnections";
import {
  useProjectIntegrations,
  type IntegrationConnectionRow,
} from "../../../../lib/hooks/useProjectIntegrations";
import type { AppConnectionRow } from "@rovenue/shared";

// CUSTOM_WEBHOOK is deliberately absent here — unlike these, it allows
// several connections per project, so it has no single "open the drawer
// for this provider" entry point. It's opened only via the card's own
// per-row Edit / "Add endpoint" actions (handleEditWebhookConnection /
// handleAddWebhookEndpoint below), never via handleOpenIntegration.
//
// Exported so apps.test.tsx can assert it stays in step with app-card.tsx's
// `DRAWER_IDS`: a card id in only one of the two is a dead end (in DRAWER_IDS
// only → the drawer opens for a provider this map can't resolve; here only →
// the card never opens the drawer at all, which is how the SLACK card
// shipped inert).
export const CARD_ID_TO_PROVIDER: Record<
  string,
  Exclude<IntegrationProviderId, "CUSTOM_WEBHOOK">
> = {
  "meta-capi": "META_CAPI",
  "tiktok-events": "TIKTOK_EVENTS",
  amplitude: "AMPLITUDE",
  mixpanel: "MIXPANEL",
  appsflyer: "APPSFLYER",
  adjust: "ADJUST",
  slack: "SLACK",
  "firebase-ga4": "FIREBASE_GA4",
  braze: "BRAZE",
  onesignal: "ONESIGNAL",
};

export const Route = createFileRoute("/_authed/projects/$projectId/apps")({
  component: AppsRoute,
});

function AppsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/apps" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AppsPage projectId={projectId} />;
}

/**
 * Overlay merge — for each catalog entry that the API knows
 * something about (Apple / Google / Stripe / outgoing webhooks),
 * we swap in the live status / lastSync / account fields. Every
 * other entry stays exactly as the static catalog defines it.
 */
function applyConnectionOverlay(
  catalog: ReadonlyArray<AppDescriptor>,
  overlay: ReadonlyArray<AppConnectionRow>,
): ReadonlyArray<AppDescriptor> {
  if (overlay.length === 0) return catalog;
  const byId = new Map(overlay.map((c) => [c.appId, c] as const));
  return catalog.map((app) => {
    const real = byId.get(app.id);
    if (!real) return app;
    return {
      ...app,
      status: real.status,
      account: real.account ?? app.account,
      lastSync: real.lastSyncLabel ?? app.lastSync,
    };
  });
}

/**
 * CUSTOM_WEBHOOK has no row in `useProjectAppConnections` (that endpoint
 * covers the single-connection catalog entries) — its "connected" status is
 * derived here from whether the project has any live (isEnabled) webhook
 * endpoint. Mirrors the `isEnabled` gate the API applies to every other
 * provider's status derivation (apps/api/src/services/apps-connections.ts:
 * `if (!conn || !conn.isEnabled) return available;`) — a project whose
 * endpoints are all disabled must not show as "Connected".
 */
export function applyWebhookStatus(
  catalog: ReadonlyArray<AppDescriptor>,
  webhookConnections: ReadonlyArray<IntegrationConnectionRow>,
): ReadonlyArray<AppDescriptor> {
  const hasEnabledEndpoint = webhookConnections.some((c) => c.isEnabled);
  if (!hasEnabledEndpoint) return catalog;
  return catalog.map((app) =>
    app.id === CUSTOM_WEBHOOK_APP_ID ? { ...app, status: "connected" } : app,
  );
}

export function AppsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<RailEntryId>("all");
  const [query, setQuery] = useState("");
  const [drawerProviderId, setDrawerProviderId] = useState<IntegrationProviderId | null>(null);
  // Which CUSTOM_WEBHOOK connection the drawer should open in edit mode.
  // null while `drawerProviderId === "CUSTOM_WEBHOOK"` means "add a new
  // endpoint" rather than "edit the first one" — CUSTOM_WEBHOOK allows many
  // connections, so (unlike META_CAPI/TIKTOK_EVENTS) provider id alone
  // doesn't identify which one to edit.
  const [editingWebhookConnectionId, setEditingWebhookConnectionId] = useState<string | null>(
    null,
  );
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const { data: project } = useProject(projectId);
  const connections = useProjectAppConnections(projectId);
  const integrations = useProjectIntegrations(projectId);

  const handleOpenIntegration = (cardId: string) => {
    const providerId = CARD_ID_TO_PROVIDER[cardId];
    if (providerId) setDrawerProviderId(providerId);
  };

  const webhookConnections = useMemo(
    () => (integrations.data ?? []).filter((c) => c.providerId === "CUSTOM_WEBHOOK"),
    [integrations.data],
  );

  const handleAddWebhookEndpoint = () => {
    setEditingWebhookConnectionId(null);
    setDrawerProviderId("CUSTOM_WEBHOOK");
  };

  const handleEditWebhookConnection = (connection: IntegrationConnectionRow) => {
    setEditingWebhookConnectionId(connection.id);
    setDrawerProviderId("CUSTOM_WEBHOOK");
  };

  const webhookCardBundle: WebhookCardBundle = {
    connections: webhookConnections,
    onAddEndpoint: handleAddWebhookEndpoint,
    onEditConnection: handleEditWebhookConnection,
  };

  const existingConnection: IntegrationConnectionRow | null = !drawerProviderId
    ? null
    : drawerProviderId === "CUSTOM_WEBHOOK"
      ? (webhookConnections.find((c) => c.id === editingWebhookConnectionId) ?? null)
      : (integrations.data?.find((c) => c.providerId === drawerProviderId) ?? null);

  const apps = useMemo<ReadonlyArray<AppDescriptor>>(
    () =>
      applyWebhookStatus(
        applyConnectionOverlay(APPS, connections.data?.connections ?? []),
        webhookConnections,
      ),
    [connections.data, webhookConnections],
  );

  const counts = useMemo(() => computeCategoryCounts(apps), [apps]);
  const connected = useMemo(
    () => apps.filter((app) => app.status === "connected"),
    [apps],
  );

  const resolveSearchText = (app: AppDescriptor) => [
    t(`apps.items.${app.id}.name`),
    t(`apps.items.${app.id}.description`),
    t(`apps.vendors.${app.vendorKey}`),
    t(`apps.categories.${app.category}`),
  ];

  const filtered = useMemo<ReadonlyArray<AppDescriptor>>(() => {
    return apps.filter((app) => {
      if (active === "connected" && app.status !== "connected") return false;
      if (active !== "all" && active !== "connected" && app.category !== active) return false;
      return matchesQuery(app, query, resolveSearchText);
    });
    // resolveSearchText is recreated each render but `t` is stable
    // per language — including it as a dep makes language switches
    // re-filter (desirable), so depend on `t` rather than the
    // helper instance.
  }, [active, query, t, apps]);

  const showHomepage = active === "all" && query.trim() === "";

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("apps.title")}
          </h1>
          <p className="mt-1 text-[12.5px] text-rv-mute-500 sm:text-[13px]">{t("apps.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "flat", size: "sm" })}
          >
            <BookOpen size={13} />
            {t("apps.actions.docs")}
          </a>
          <Button variant="flat" size="sm" onClick={() => setWebhookModalOpen(true)}>
            <Webhook size={13} />
            {t("apps.actions.customWebhook")}
          </Button>
        </div>
      </header>

      <AppsHero totalApps={counts.all} connectedApps={counts.connected} />

      {project?.webhookUrl && (
        <ConfiguredWebhookCard
          projectId={projectId}
          url={project.webhookUrl}
          categories={project.webhookEventCategories}
          hasSecret={project.hasWebhookSecret}
        />
      )}

      <div className="grid items-start gap-4 grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <CategoryRail active={active} counts={counts} onSelect={setActive} />

        <main className="min-w-0">
          <AppsToolbar query={query} onQueryChange={setQuery} />

          {showHomepage ? (
            <>
              <ConnectedStrip apps={connected} />
              {HOMEPAGE_SECTIONS.map((category) => (
                <AppsSection
                  key={category}
                  category={category}
                  apps={apps.filter((app) => app.category === category).slice(0, 4)}
                  totalCount={counts[category] ?? 0}
                  onViewAll={(next) => setActive(next)}
                  onOpenIntegration={handleOpenIntegration}
                  webhook={webhookCardBundle}
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
                    <AppCard
                      key={app.id}
                      app={app}
                      onOpenIntegration={handleOpenIntegration}
                      webhook={app.id === CUSTOM_WEBHOOK_APP_ID ? webhookCardBundle : undefined}
                    />
                  ))}
                </div>
              ) : (
                <AppsEmptyState />
              )}
            </>
          )}

          <BuildYourOwnCard onNewWebhook={() => setWebhookModalOpen(true)} />
        </main>
      </div>

      {drawerProviderId && (
        <IntegrationDrawer
          open={true}
          onClose={() => {
            setDrawerProviderId(null);
            setEditingWebhookConnectionId(null);
          }}
          projectId={projectId}
          providerId={drawerProviderId}
          existingConnection={existingConnection}
        />
      )}
      {webhookModalOpen && (
        <CustomWebhookModal
          open={true}
          onClose={() => setWebhookModalOpen(false)}
          projectId={projectId}
        />
      )}
    </>
  );
}
