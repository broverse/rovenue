import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { PROJECT_SECRETS } from "./mock-data";
import { SecretRow } from "./secret-row";

export function KeysCard() {
  const { t } = useTranslation();

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-5 py-4">
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
      <div className="flex flex-col gap-2 px-5 py-4">
        {PROJECT_SECRETS.map((secret) => (
          <SecretRow
            key={secret.id}
            secret={secret}
            readOnly={secret.kind === "publishable"}
          />
        ))}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 rounded-b-lg border-t border-rv-divider bg-rv-c2 px-5 py-3">
        <span className="text-[12px] text-rv-mute-500">{t("sdkApi.keys.footer.note")}</span>
        <Button variant="light" size="sm">
          {t("sdkApi.keys.footer.audit")}
        </Button>
      </footer>
    </section>
  );
}
