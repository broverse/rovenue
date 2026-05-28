import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { AppLogo } from "./app-logo";
import type { AppDescriptor } from "./types";

const DRAWER_IDS = new Set(["meta-capi", "tiktok-events"]);

type Props = {
  app: AppDescriptor;
  onSelect?: (id: string) => void;
  onOpenIntegration?: (providerId: string) => void;
};

export function AppCard({ app, onSelect, onOpenIntegration }: Props) {
  const { t } = useTranslation();
  const connected = app.status === "connected";

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
    </article>
  );
}
