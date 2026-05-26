import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface StoreCredentialExpiredCtx {
  projectId: string;
  projectName: string;
  provider: "apple" | "google" | "stripe";
  expiresAt?: string;
  reconnectUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "integration.store-credential-expired";

function interp(
  ctx: StoreCredentialExpiredCtx,
  t: TFunction,
): Record<string, unknown> {
  return {
    ...ctx,
    providerLabel: t(`${NS}:provider.${ctx.provider}`) as string,
    expiresAt: ctx.expiresAt ?? "",
  };
}

function tt(t: TFunction, ctx: StoreCredentialExpiredCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx, t)) as string;
}

function Email({ ctx, t }: { ctx: StoreCredentialExpiredCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      meta={ctx.expiresAt ? tt(t, ctx, "body.expiresAt") : undefined}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.reconnectUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<StoreCredentialExpiredCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
