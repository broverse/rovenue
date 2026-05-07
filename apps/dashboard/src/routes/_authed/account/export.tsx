import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { Download } from "lucide-react";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";

export const Route = createFileRoute("/_authed/account/export")({
  component: ExportPage,
});

function ExportPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="export">
      <AccountPageHeader
        title={t("account.export.title")}
        description={t("account.export.subtitle")}
      />

      <SectionCard
        title={t("account.export.data.title")}
        description={t("account.export.data.subtitle")}
      >
        <Button variant="flat">
          <Download size={13} />
          {t("account.export.data.action")}
        </Button>
        <p className="mt-2 text-[11px] leading-relaxed text-rv-mute-500">
          {t("account.export.data.hint")}
        </p>
      </SectionCard>

      <SectionCard
        tone="danger"
        title={t("account.export.transfer.title")}
        description={t("account.export.transfer.subtitle")}
      >
        <Button variant="flat">{t("account.export.transfer.action")}</Button>
      </SectionCard>

      <SectionCard
        tone="danger"
        title={t("account.export.close.title")}
        description={t("account.export.close.subtitle")}
      >
        <div className="mb-3 rounded-md border border-rv-danger/25 bg-rv-danger/5 p-3.5 text-[12px] text-rv-mute-700">
          <Trans
            i18nKey="account.export.close.warning"
            components={{ b: <b className="text-rv-danger" /> }}
          />
        </div>
        <Button
          variant="flat"
          className="border-rv-danger/35 text-rv-danger hover:bg-rv-danger/10"
        >
          {t("account.export.close.action")}
        </Button>
      </SectionCard>
    </AccountShell>
  );
}
