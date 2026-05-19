import { useTranslation } from "react-i18next";
import { ArrowUpRight, CircleAlert, CircleCheck, RotateCw } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip, type ChipProps } from "../../ui/chip";
import { CopyButton } from "../../ui/copy-button";
import { WEBHOOK_DELIVERIES } from "./mock-data";
import type { WebhookDelivery } from "./types";

interface Props {
  /** Project webhook URL — null when the operator hasn't set one yet. */
  endpoint: string | null;
  /**
   * Whether the webhook signing secret is currently set. The server
   * never echoes the secret on read; it's only revealed once at
   * rotation time, so the card just surfaces a configured/missing
   * indicator here.
   */
  hasSecret: boolean;
}

const STATUS_TONE: Record<WebhookDelivery["status"], NonNullable<ChipProps["tone"]>> = {
  ok: "success",
  retry: "warning",
  failed: "danger",
};

export function WebhookCard({ endpoint, hasSecret }: Props) {
  const { t } = useTranslation();
  const endpointDisplay =
    endpoint ?? t("sdkApi.webhooks.endpointMissing", "Not configured");

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("sdkApi.webhooks.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("sdkApi.webhooks.subtitle")}
          </p>
        </div>
        <Button variant="flat" size="sm" disabled={!endpoint}>
          <RotateCw size={13} />
          {t("sdkApi.webhooks.actions.test")}
        </Button>
      </header>

      <div className="grid gap-3 border-b border-rv-divider px-4 py-4 sm:grid-cols-2 sm:px-5">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("sdkApi.webhooks.endpoint")}
          </div>
          <div className="mt-1 flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5">
            <code
              className={`truncate font-rv-mono text-[12px] ${
                endpoint ? "text-foreground" : "text-rv-mute-500"
              }`}
            >
              {endpointDisplay}
            </code>
            {endpoint && (
              <CopyButton
                size="xs"
                value={endpoint}
                label={t("sdkApi.copy.idle")}
                copiedLabel={t("sdkApi.copy.copied")}
              />
            )}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("sdkApi.webhooks.signingSecret")}
          </div>
          <div className="mt-1 flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5">
            <Chip tone={hasSecret ? "success" : "warning"}>
              {hasSecret
                ? t("sdkApi.webhooks.secretConfigured", "Configured")
                : t("sdkApi.webhooks.secretMissing", "Not set")}
            </Chip>
            <span className="text-[11px] text-rv-mute-500">
              {t(
                "sdkApi.webhooks.secretHint",
                "Rotate to reveal the signing secret.",
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <div className="mb-2.5 flex items-baseline justify-between">
          <h4 className="text-[12px] font-semibold uppercase tracking-wider text-rv-mute-600">
            {t("sdkApi.webhooks.recent.title")}
          </h4>
          <a
            href="#"
            className="inline-flex items-center gap-1 text-[11.5px] text-rv-accent-500 hover:text-rv-accent-400"
          >
            {t("sdkApi.webhooks.recent.viewAll")}
            <ArrowUpRight size={11} />
          </a>
        </div>
        {/*
         * Recent delivery rows stay on mock data here — the dashboard
         * only has /webhooks/failed (dead-letter only) right now, which
         * is the wrong dataset for a "last successful + retry" stream.
         * A dedicated recent-deliveries endpoint lands in Phase 3.
         */}
        <ul className="flex flex-col gap-1.5">
          {WEBHOOK_DELIVERIES.map((delivery) => {
            const Icon = delivery.status === "ok" ? CircleCheck : CircleAlert;
            return (
              <li
                key={delivery.id}
                className="grid items-center gap-2.5 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
              >
                <Icon
                  size={13}
                  className={
                    delivery.status === "ok"
                      ? "text-rv-success"
                      : delivery.status === "retry"
                        ? "text-rv-warning"
                        : "text-rv-danger"
                  }
                />
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-foreground">
                    {t(`sdkApi.webhooks.events.${delivery.eventKey}`)}
                  </div>
                  <div className="font-rv-mono text-[10.5px] text-rv-mute-500">
                    {delivery.id} · {t(`sdkApi.webhooks.age.${delivery.ageKey}`)}
                  </div>
                </div>
                <span className="hidden font-rv-mono text-[11px] tabular-nums text-rv-mute-600 sm:inline-block">
                  {delivery.latencyMs} ms
                </span>
                <Chip tone={STATUS_TONE[delivery.status]}>
                  {t(`sdkApi.webhooks.status.${delivery.status}`)}
                </Chip>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
