import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import { formatCents } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface CreditLowBalanceCtx {
  projectId: string;
  projectName: string;
  balanceCents: number;
  thresholdCents: number;
  /** ISO currency for the balance display (defaults to USD). */
  currency?: string;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "billing.credit-low-balance";

function interp(ctx: CreditLowBalanceCtx): Record<string, unknown> {
  const locale = ctx.locale ?? "en";
  const cur = ctx.currency ?? "USD";
  return {
    ...ctx,
    balanceFormatted: formatCents(ctx.balanceCents, cur, locale),
    thresholdFormatted: formatCents(ctx.thresholdCents, cur, locale),
  };
}

function tt(t: TFunction, ctx: CreditLowBalanceCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx)) as string;
}

function Email({ ctx, t }: { ctx: CreditLowBalanceCtx; t: TFunction }) {
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

export const template: TemplateModule<CreditLowBalanceCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
