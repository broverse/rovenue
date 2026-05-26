import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface ChurnSpikeCtx {
  projectId: string;
  projectName: string;
  churnRatePct: number;
  baselinePct: number;
  windowDays: number;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "revenue.churn-spike";

function tt(t: TFunction, ctx: ChurnSpikeCtx, k: string): string {
  return t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
}

function Email({ ctx, t }: { ctx: ChurnSpikeCtx; t: TFunction }) {
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

export const template: TemplateModule<ChurnSpikeCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
