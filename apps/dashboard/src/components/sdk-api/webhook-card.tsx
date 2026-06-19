import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import { CopyButton } from "../../ui/copy-button";

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
      </header>

      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5">
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
    </section>
  );
}
