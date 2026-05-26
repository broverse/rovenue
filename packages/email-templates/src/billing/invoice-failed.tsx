import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import { formatCents } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface InvoiceFailedCtx {
  invoiceId: string;
  amount: { amount: number; currency: string };
  reason: string;
  hostedInvoiceUrl?: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "billing.invoice-failed";

function interp(ctx: InvoiceFailedCtx): Record<string, unknown> {
  const locale = ctx.locale ?? "en";
  return {
    ...ctx,
    amountFormatted: formatCents(ctx.amount.amount, ctx.amount.currency, locale),
  };
}

function tt(t: TFunction, ctx: InvoiceFailedCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx)) as string;
}

function Email({ ctx, t }: { ctx: InvoiceFailedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={`${tt(t, ctx, "body")}\n\n${tt(t, ctx, "body.fallback")}`}
      cta={
        ctx.hostedInvoiceUrl
          ? { label: tt(t, ctx, "cta"), href: ctx.hostedInvoiceUrl }
          : undefined
      }
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<InvoiceFailedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
