import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { ProjectApiKey } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { SecretRow } from "./secret-row";

interface Props {
  apiKeys: ReadonlyArray<ProjectApiKey>;
}

/** Truncate to "pk_live_…last8" so the row preview never shows the full identifier. */
function previewKey(value: string): string {
  if (value.length <= 14) return value;
  const head = value.slice(0, 8);
  const tail = value.slice(-4);
  return `${head}…${tail}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "Created today";
  if (days < 7) return `Created ${days}d ago`;
  if (days < 30) return `Created ${Math.floor(days / 7)}w ago`;
  return `Created ${new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

export function KeysCard({ apiKeys }: Props) {
  const { t } = useTranslation();

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("sdkApi.keys.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("sdkApi.keys.subtitle")}
          </p>
        </div>
        <Button variant="solid-primary" size="sm">
          <Plus size={13} />
          {t("sdkApi.keys.actions.create")}
        </Button>
      </header>
      <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
        {apiKeys.length === 0 && (
          <div className="rounded-md border border-dashed border-rv-divider bg-rv-c2 px-3 py-6 text-center text-[12px] text-rv-mute-500">
            {t("sdkApi.keys.empty", "No API keys yet. Create one to start hitting the API.")}
          </div>
        )}
        {apiKeys.map((key) => (
          <SecretRow
            key={key.id}
            label={key.label}
            created={formatRelative(key.createdAt)}
            environment={t(
              `sdkApi.keys.environments.${key.environment === "PRODUCTION" ? "production" : "sandbox"}`,
            )}
            kind="publishable"
            value={key.publicKey}
            preview={previewKey(key.publicKey)}
            readOnly
          />
        ))}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 rounded-b-lg border-t border-rv-divider bg-rv-c2 px-4 py-3 sm:px-5">
        <span className="text-[12px] text-rv-mute-500">
          {t("sdkApi.keys.footer.note")}
        </span>
        <Button variant="light" size="sm">
          {t("sdkApi.keys.footer.audit")}
        </Button>
      </footer>
    </section>
  );
}
