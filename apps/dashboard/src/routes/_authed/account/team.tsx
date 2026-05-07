import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
} from "../../../components/account";

export const Route = createFileRoute("/_authed/account/team")({
  component: TeamPage,
});

function TeamPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="team">
      <AccountPageHeader
        title={t("account.team.title")}
        description={t("account.team.subtitle")}
      />

      <SectionCard title={t("account.team.placeholder.title")}>
        <p className="text-[13px] leading-relaxed text-rv-mute-600">
          <Trans
            i18nKey="account.team.placeholder.body"
            components={{ b: <b className="text-foreground" /> }}
          />
        </p>
      </SectionCard>
    </AccountShell>
  );
}
