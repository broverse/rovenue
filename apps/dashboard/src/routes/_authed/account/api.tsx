import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  AccountPageHeader,
  AccountShell,
  ApiKeyRow,
  SectionCard,
} from "../../../components/account";
import { Button } from "../../../ui/button";

export const Route = createFileRoute("/_authed/account/api")({
  component: ApiPage,
});

const TOKENS = [
  {
    nameKey: "scripts.name",
    metaKey: "scripts.meta",
    secret: "rvn_pat_a82f…d11c",
  },
  {
    nameKey: "linear.name",
    metaKey: "linear.meta",
    secret: "rvn_pat_b14e…78fa",
  },
  {
    nameKey: "local.name",
    metaKey: "local.meta",
    secret: "rvn_pat_c91d…44e2",
  },
] as const;

function ApiPage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="api">
      <AccountPageHeader
        title={t("account.api.title")}
        description={t("account.api.subtitle")}
      />

      <SectionCard
        title={t("account.api.tokens.title")}
        description={t("account.api.tokens.subtitle")}
        right={
          <Button variant="solid-primary">
            <Plus size={13} />
            {t("account.api.tokens.new")}
          </Button>
        }
      >
        {TOKENS.map((token) => (
          <ApiKeyRow
            key={token.secret}
            name={t(`account.api.tokens.items.${token.nameKey}`)}
            meta={t(`account.api.tokens.items.${token.metaKey}`)}
            secret={token.secret}
          />
        ))}
      </SectionCard>
    </AccountShell>
  );
}
