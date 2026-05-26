import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import { formatCents } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface RefundDetectedCtx {
  projectId: string;
  projectName: string;
  amount: { amount: number; currency: string };
  reason: "high_value" | "burst";
  productId?: string;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "billing.refund-detected";

function interp(ctx: RefundDetectedCtx, t: TFunction): Record<string, unknown> {
  const locale = ctx.locale ?? "en";
  return {
    ...ctx,
    amountFormatted: formatCents(ctx.amount.amount, ctx.amount.currency, locale),
    reasonLabel: t(`${NS}:reason.${ctx.reason}`) as string,
    productId: ctx.productId ?? "",
  };
}

function tt(t: TFunction, ctx: RefundDetectedCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx, t)) as string;
}

function Email({ ctx, t }: { ctx: RefundDetectedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      meta={ctx.productId ? tt(t, ctx, "body.product") : undefined}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.dashboardUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<RefundDetectedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
