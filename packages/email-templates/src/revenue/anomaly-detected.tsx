import { Button, Heading, Text } from "@react-email/components";
import type { TFunction } from "i18next";
import { BaseLayout } from "../layouts/base-layout";
import type { TemplateModule } from "../registry";

export interface AnomalyDetectedCtx {
  projectId: string;
  projectName: string;
  metric: "mrr" | "subs" | "churn";
  direction: "up" | "down";
  magnitudePct: number;
  windowMinutes: number;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "revenue.anomaly-detected";

const buttonStyle = {
  background: "#111",
  color: "white",
  padding: "10px 16px",
  borderRadius: 6,
} as const;

function Email({ ctx, t }: { ctx: AnomalyDetectedCtx; t: TFunction }) {
  const tt = (k: string) =>
    t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
  return (
    <BaseLayout
      t={t}
      preview={tt("preview")}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    >
      <Heading>{tt("headline")}</Heading>
      <Text>{tt("body")}</Text>
      <Button href={ctx.dashboardUrl} style={buttonStyle}>
        {tt("cta")}
      </Button>
    </BaseLayout>
  );
}

export const template: TemplateModule<AnomalyDetectedCtx> = {
  Component: Email,
  subject: (ctx, t) =>
    t(`${NS}:subject`, ctx as unknown as Record<string, unknown>) as string,
  pushTitle: (ctx, t) =>
    t(`${NS}:push.title`, ctx as unknown as Record<string, unknown>) as string,
  pushBody: (ctx, t) =>
    t(`${NS}:push.body`, ctx as unknown as Record<string, unknown>) as string,
};
