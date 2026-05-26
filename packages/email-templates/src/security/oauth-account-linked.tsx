import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface OauthAccountLinkedCtx {
  provider: "github" | "google";
  whenIso: string;
  connectedAccountsUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "security.oauth-account-linked";

function interp(
  ctx: OauthAccountLinkedCtx,
  t: TFunction,
): Record<string, unknown> {
  return {
    ...ctx,
    providerLabel: t(`${NS}:provider.${ctx.provider}`) as string,
  };
}

function tt(t: TFunction, ctx: OauthAccountLinkedCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx, t)) as string;
}

function Email({ ctx, t }: { ctx: OauthAccountLinkedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={`${tt(t, ctx, "body")}\n\n${tt(t, ctx, "body.tail")}`}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.connectedAccountsUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<OauthAccountLinkedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
