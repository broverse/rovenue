import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { AppLogo } from "./app-logo";
import { CUSTOM_WEBHOOK_APP_ID } from "./mock-data";
import type { AppDescriptor } from "./types";
import type { IntegrationConnectionRow } from "../../lib/hooks/useProjectIntegrations";

const DRAWER_IDS = new Set(["meta-capi", "tiktok-events"]);

// Mirrors apps/api/src/routes/dashboard/integrations.ts's
// `MAX_WEBHOOK_ENDPOINTS_PER_PROJECT`. Duplicated here because dashboard
// code can't import from the API package — keep both in sync if the cap
// ever changes.
export const MAX_WEBHOOK_ENDPOINTS_PER_PROJECT = 10;

export interface WebhookCardBundle {
  connections: IntegrationConnectionRow[];
  onAddEndpoint: () => void;
  onEditConnection: (connection: IntegrationConnectionRow) => void;
}

type Props = {
  app: AppDescriptor;
  onSelect?: (id: string) => void;
  onOpenIntegration?: (providerId: string) => void;
  /** Only meaningful for the CUSTOM_WEBHOOK catalog entry — when present,
   *  the card lists every connection for the project instead of the usual
   *  single Connect/Configure button (a project may have several webhook
   *  endpoints, unlike every other provider). */
  webhook?: WebhookCardBundle;
};

export function AppCard({ app, onSelect, onOpenIntegration, webhook }: Props) {
  const { t } = useTranslation();
  const connected = app.status === "connected";
  const isWebhookCard = app.id === CUSTOM_WEBHOOK_APP_ID && webhook !== undefined;

  const handleCardClick = () => {
    if (app.status !== "unavailable" && DRAWER_IDS.has(app.id)) {
      onOpenIntegration?.(app.id);
    }
  };

  const isDrawerApp = app.status !== "unavailable" && DRAWER_IDS.has(app.id);

  return (
    <article
      role={isDrawerApp ? "button" : undefined}
      tabIndex={isDrawerApp ? 0 : undefined}
      onClick={isDrawerApp ? handleCardClick : undefined}
      onKeyDown={isDrawerApp ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardClick(); } } : undefined}
      className={cn(
        "relative flex min-h-[168px] flex-col gap-3 rounded-lg border bg-rv-c1 p-4 transition",
        connected
          ? "border-[color-mix(in_srgb,var(--color-rv-success)_28%,var(--color-rv-divider))]"
          : "border-rv-divider hover:border-rv-divider-strong",
        isDrawerApp && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500",
      )}
    >
      <header className="flex items-start gap-3">
        <AppLogo logo={app.logo} />
        <div className="min-w-0 flex-1">
          <h4 className="text-[13.5px] font-semibold leading-tight text-foreground">
            {t(`apps.items.${app.id}.name`)}
          </h4>
          <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
            {t(`apps.vendors.${app.vendorKey}`)}
          </div>
        </div>
        {app.featured && (
          <span className="inline-flex items-center gap-1 rounded bg-rv-accent-500/14 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-accent-400">
            <Star size={10} className="fill-current" />
            {t("apps.card.featured")}
          </span>
        )}
      </header>

      {isWebhookCard ? (
        <WebhookConnectionsBody bundle={webhook} />
      ) : (
        <>
          <p className="flex-1 text-[12px] leading-[1.55] text-rv-mute-600">
            {t(`apps.items.${app.id}.description`)}
          </p>

          <footer className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
              {t(`apps.categoryShort.${app.category}`)}
            </span>
            {app.tag === "new" && (
              <span className="rounded bg-rv-warning/14 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-warning">
                {t("apps.card.tags.new")}
              </span>
            )}
            {app.tag === "beta" && (
              <span className="rounded bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-500">
                {t("apps.card.tags.beta")}
              </span>
            )}
            {app.tag === "partner" && (
              <span className="rounded bg-[color-mix(in_srgb,#A78BFA_16%,transparent)] px-1.5 py-0.5 font-rv-mono text-[10px] text-[#C4B5FD]">
                {t("apps.card.tags.partner")}
              </span>
            )}
            {connected && (
              <span className="inline-flex items-center gap-1 rounded bg-rv-success/14 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-success">
                <span className="h-1 w-1 rounded-full bg-rv-success shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-success)_30%,transparent)]" />
                {t("apps.card.connected")}
              </span>
            )}
            <Button
              variant="flat"
              size="sm"
              className={cn(
                "ml-auto h-[26px] px-2.5 text-[11.5px]",
                connected &&
                  "border-[color-mix(in_srgb,var(--color-rv-success)_30%,var(--color-rv-divider))] bg-rv-success/12 text-rv-success hover:bg-rv-success/16 hover:text-rv-success",
              )}
              onClick={() => onSelect?.(app.id)}
            >
              {connected ? t("apps.card.configure") : t("apps.card.connect")}
            </Button>
          </footer>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Multi-connection body — CUSTOM_WEBHOOK only
// ---------------------------------------------------------------------------

function WebhookConnectionsBody({ bundle }: { bundle: WebhookCardBundle }) {
  const { t } = useTranslation();
  const { connections, onAddEndpoint, onEditConnection } = bundle;
  const atCap = connections.length >= MAX_WEBHOOK_ENDPOINTS_PER_PROJECT;

  return (
    <div className="flex flex-1 flex-col gap-2">
      {connections.length === 0 ? (
        <p className="flex-1 text-[12px] text-rv-mute-500">
          {t("apps.card.webhook.noEndpoints")}
        </p>
      ) : (
        <ul className="m-0 flex flex-1 list-none flex-col gap-1.5 p-0">
          {connections.map((conn) => (
            <li
              key={conn.id}
              className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-foreground">
                  {conn.displayName}
                </div>
                <div className="truncate font-rv-mono text-[10.5px] text-rv-mute-500">
                  {conn.credentialsHint}
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 font-rv-mono text-[10px]",
                  conn.isEnabled
                    ? "bg-rv-success/14 text-rv-success"
                    : "bg-rv-c3 text-rv-mute-500",
                )}
              >
                {conn.isEnabled
                  ? t("apps.card.webhook.enabled")
                  : t("apps.card.webhook.disabled")}
              </span>
              <button
                type="button"
                onClick={() => onEditConnection(conn)}
                aria-label={`${t("apps.card.webhook.edit")} ${conn.displayName}`}
                className="shrink-0 rounded border border-rv-divider bg-rv-c1 px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-rv-c3"
              >
                {t("apps.card.webhook.edit")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onAddEndpoint}
        disabled={atCap}
        title={
          atCap
            ? t("apps.card.webhook.atCapTooltip", { max: MAX_WEBHOOK_ENDPOINTS_PER_PROJECT })
            : undefined
        }
        className={cn(
          "self-start rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5 text-[11.5px] font-medium text-foreground transition hover:bg-rv-c3",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {t("apps.card.webhook.addEndpoint")}
      </button>
    </div>
  );
}
