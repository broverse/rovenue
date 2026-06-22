import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  SectionCard,
  UsageRow,
} from "../../../components/account";
import { Button } from "../../../ui/button";
import { useBillingUsage, type UsageMeter } from "../../../lib/hooks/useBillingUsage";
import { useProjects } from "../../../lib/hooks/useProjects";
import { billingEnabled } from "../../../lib/host-mode";

export const Route = createFileRoute("/_authed/account/usage")({
  component: UsagePage,
});

// meter key → i18n key under account.usage.items
const I18N_KEY: Record<UsageMeter["key"], string> = {
  mtr: "mtr",
  events: "events",
  sql_queries: "sql",
};

function daysRemaining(periodEnd: string): number {
  const ms = new Date(periodEnd).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

const formatResetDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function UsagePage() {
  const { t } = useTranslation();
  const projects = useProjects();
  const projectId = useMemo(
    () => (projects.data ?? [])[0]?.id ?? "",
    [projects.data],
  );

  const { data, isLoading } = useBillingUsage(projectId);

  return (
    <AccountShell active="usage">
      <AccountPageHeader
        title={t("account.usage.title")}
        description={t("account.usage.subtitle")}
      />

      <SectionCard
        title={t("account.usage.limits.title")}
        description={t("account.usage.limits.subtitle")}
        meta={
          data
            ? t("account.usage.limits.resets", { date: formatResetDate(data.periodEnd), remaining: daysRemaining(data.periodEnd) })
            : undefined
        }
        footer={billingEnabled ? <Button variant="solid-primary">{t("account.billing.plan.upgrade")}</Button> : undefined}
      >
        {isLoading || !data ? (
          <div className="py-3 text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : (
          data.meters.map((m) => (
            <UsageRow
              key={m.key}
              name={t(`account.usage.items.${I18N_KEY[m.key]}.name`)}
              description={t(`account.usage.items.${I18N_KEY[m.key]}.desc`)}
              capLabel={t(`account.usage.cap.${m.cap}`)}
              current={m.current}
              limit={m.limit}
              unit={m.unit}
              unavailable={!m.available}
              unavailableLabel={t("account.usage.unavailable")}
            />
          ))
        )}
      </SectionCard>
    </AccountShell>
  );
}
