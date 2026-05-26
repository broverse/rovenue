import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import { formatCents } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface InvoicePaidCtx {
  invoiceId: string;
  amount: { amount: number; currency: string };
  periodStart: string;
  periodEnd: string;
  hostedInvoiceUrl?: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "billing.invoice-paid";

function interp(ctx: InvoicePaidCtx): Record<string, unknown> {
  const locale = ctx.locale ?? "en";
  return {
    ...ctx,
    amountFormatted: formatCents(ctx.amount.amount, ctx.amount.currency, locale),
  };
}

function tt(t: TFunction, ctx: InvoicePaidCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx)) as string;
}

function Email({ ctx, t }: { ctx: InvoicePaidCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
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

export const template: TemplateModule<InvoicePaidCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
