import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface InvitedCtx {
  projectId: string;
  projectName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  /** ISO timestamp; if present, footer mentions the expiry. */
  expiresAt?: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "team.invited";

function tt(t: TFunction, ctx: InvitedCtx, k: string): string {
  return t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
}

function Email({ ctx, t }: { ctx: InvitedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      meta={ctx.expiresAt ? tt(t, ctx, "body.expires") : tt(t, ctx, "body.tail")}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.acceptUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<InvitedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
