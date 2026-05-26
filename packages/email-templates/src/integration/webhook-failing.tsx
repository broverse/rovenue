import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface WebhookFailingCtx {
  projectId: string;
  projectName: string;
  webhookId: string;
  endpointUrl: string;
  consecutiveFailures: number;
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "integration.webhook-failing";

function tt(t: TFunction, ctx: WebhookFailingCtx, k: string): string {
  return t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
}

function Email({ ctx, t }: { ctx: WebhookFailingCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      meta={tt(t, ctx, "body.meta")}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.dashboardUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<WebhookFailingCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
