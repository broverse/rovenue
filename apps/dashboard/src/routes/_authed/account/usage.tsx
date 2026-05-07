import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
  UsageRow,
} from "../../../components/account";
import { Button } from "../../../ui/button";

export const Route = createFileRoute("/_authed/account/usage")({
  component: UsagePage,
});

type CapType = "hard" | "soft";

type UsageItem = {
  key: string;
  current: number;
  limit: number;
  cap: CapType;
};

const ITEMS: ReadonlyArray<UsageItem> = [
  { key: "subscribers", current: 38420, limit: 50000, cap: "hard" },
  { key: "events", current: 6_842_000, limit: 10_000_000, cap: "hard" },
  { key: "charts", current: 142, limit: 500, cap: "soft" },
  { key: "seats", current: 12, limit: 25, cap: "hard" },
  { key: "api", current: 184_200, limit: 500_000, cap: "soft" },
  { key: "sql", current: 92, limit: 100, cap: "hard" },
];

function UsagePage() {
  const { t } = useTranslation();

  return (
    <AccountShell active="usage">
      <AccountPageHeader
        title={t("account.usage.title")}
        description={t("account.usage.subtitle")}
      />

      <SectionCard
        title={t("account.usage.limits.title")}
        description={t("account.usage.limits.subtitle")}
        meta={t("account.usage.limits.resets", { remaining: 24 })}
        footer={<Button variant="solid-primary">{t("account.billing.plan.upgrade")}</Button>}
      >
        {ITEMS.map((u) => (
          <UsageRow
            key={u.key}
            name={t(`account.usage.items.${u.key}.name`)}
            description={t(`account.usage.items.${u.key}.desc`)}
            capLabel={t(`account.usage.cap.${u.cap}`)}
            current={u.current}
            limit={u.limit}
          />
        ))}
      </SectionCard>
    </AccountShell>
  );
}
