import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import { formatCents } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface MilestoneHitCtx {
  projectId: string;
  projectName: string;
  milestone: { amount: number; currency: string };
  metric: "mrr" | "total_revenue";
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "revenue.milestone-hit";

function interp(ctx: MilestoneHitCtx, t: TFunction): Record<string, unknown> {
  const locale = ctx.locale ?? "en";
  return {
    ...ctx,
    milestoneFormatted: formatCents(
      ctx.milestone.amount,
      ctx.milestone.currency,
      locale,
    ),
    metricLabel: t(`${NS}:metric.${ctx.metric}`) as string,
  };
}

function tt(t: TFunction, ctx: MilestoneHitCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx, t)) as string;
}

function Email({ ctx, t }: { ctx: MilestoneHitCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.dashboardUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<MilestoneHitCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
