import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  AccountToggleRow,
  SectionCard,
} from "../../../components/account";

export const Route = createFileRoute("/_authed/account/notifications")({
  component: NotificationsPage,
});

const KEYS = [
  "email",
  "slack",
  "push",
  "daily_digest",
  "weekly_summary",
  "anomaly",
  "milestone",
  "churn_spike",
  "invoice",
  "refund_alert",
  "low_balance",
  "product_news",
  "marketing",
] as const;

type NotifKey = (typeof KEYS)[number];

const DEFAULTS: Record<NotifKey, boolean> = {
  email: true,
  slack: true,
  push: true,
  daily_digest: true,
  weekly_summary: true,
  anomaly: true,
  milestone: false,
  churn_spike: true,
  invoice: true,
  refund_alert: true,
  low_balance: true,
  product_news: false,
  marketing: false,
};

function NotificationsPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<Record<NotifKey, boolean>>(DEFAULTS);
  const toggle = (k: NotifKey) => setState((s) => ({ ...s, [k]: !s[k] }));

  const groups = [
    {
      titleKey: "account.notifications.channels.title",
      subtitleKey: "account.notifications.channels.subtitle",
      keys: ["email", "slack", "push"] as NotifKey[],
    },
    {
      titleKey: "account.notifications.revenue.title",
      subtitleKey: "account.notifications.revenue.subtitle",
      keys: ["daily_digest", "weekly_summary", "anomaly", "milestone", "churn_spike"] as NotifKey[],
    },
    {
      titleKey: "account.notifications.billing.title",
      subtitleKey: "account.notifications.billing.subtitle",
      keys: ["invoice", "refund_alert", "low_balance"] as NotifKey[],
    },
    {
      titleKey: "account.notifications.marketing.title",
      subtitleKey: "account.notifications.marketing.subtitle",
      keys: ["product_news", "marketing"] as NotifKey[],
    },
  ];

  return (
    <AccountShell active="notifications">
      <AccountPageHeader
        title={t("account.notifications.title")}
        description={t("account.notifications.subtitle")}
      />

      {groups.map((g) => (
        <SectionCard
          key={g.titleKey}
          title={t(g.titleKey)}
          description={t(g.subtitleKey)}
        >
          {g.keys.map((k) => (
            <AccountToggleRow
              key={k}
              title={t(`account.notifications.items.${k}.title`)}
              description={t(`account.notifications.items.${k}.desc`, { defaultValue: "" }) || undefined}
              checked={state[k]}
              onChange={() => toggle(k)}
            />
          ))}
        </SectionCard>
      ))}
    </AccountShell>
  );
}
