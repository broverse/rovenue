import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Webhook } from "lucide-react";
import type { WebhookEventCategory } from "@rovenue/shared";
import { Chip } from "../../ui/chip";

interface Props {
  projectId: string;
  url: string;
  categories: WebhookEventCategory[];
  hasSecret: boolean;
}

/**
 * Surfaces the project's single configured outgoing webhook on the
 * Apps & integrations page. Rendered only when a webhook URL is set;
 * links through to the detail route for config + delivery history.
 */
export function ConfiguredWebhookCard({ projectId, url, categories, hasSecret }: Props) {
  const { t } = useTranslation();
  const categoryLabel =
    categories.length === 0
      ? t("apps.configuredWebhook.allEvents")
      : categories.map((c) => t(`apps.customWebhook.categories.${c}`)).join(", ");

  return (
    <Link
      to="/projects/$projectId/apps/webhooks"
      params={{ projectId }}
      className="mb-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5 transition hover:border-rv-accent-500/40 hover:bg-rv-c2"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-accent-500">
        <Webhook size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">
            {t("apps.configuredWebhook.title")}
          </span>
          <Chip tone="success">{t("apps.configuredWebhook.active")}</Chip>
          <Chip tone={hasSecret ? "success" : "warning"}>
            {hasSecret
              ? t("apps.configuredWebhook.secretSet")
              : t("apps.configuredWebhook.secretMissing")}
          </Chip>
        </div>
        <div className="mt-0.5 truncate font-rv-mono text-[11.5px] text-rv-mute-500">{url}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-rv-mute-500">{categoryLabel}</div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-rv-accent-500">
        {t("apps.configuredWebhook.viewDetail")}
        <ArrowUpRight size={12} />
      </span>
    </Link>
  );
}
