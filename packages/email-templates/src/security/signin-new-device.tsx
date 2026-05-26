import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface SigninNewDeviceCtx {
  userAgent: string;
  ipAddress: string;
  approxLocation?: string;
  whenIso: string;
  reviewDevicesUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "security.signin-new-device";

function interp(ctx: SigninNewDeviceCtx): Record<string, unknown> {
  return {
    ...ctx,
    locationOrIp: ctx.approxLocation ?? ctx.ipAddress,
  };
}

function tt(t: TFunction, ctx: SigninNewDeviceCtx, k: string): string {
  return t(`${NS}:${k}`, interp(ctx)) as string;
}

function Email({ ctx, t }: { ctx: SigninNewDeviceCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={`${tt(t, ctx, "body")}\n\n${tt(t, ctx, "body.tail")}`}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.reviewDevicesUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<SigninNewDeviceCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: (ctx, t) => tt(t, ctx, "push.title"),
  pushBody: (ctx, t) => tt(t, ctx, "push.body"),
};
