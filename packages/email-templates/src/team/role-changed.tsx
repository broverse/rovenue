import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface RoleChangedCtx {
  projectId: string;
  projectName: string;
  oldRole: string;
  newRole: string;
  changedByName: string;
  projectUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "team.role-changed";

function tt(t: TFunction, ctx: RoleChangedCtx, k: string): string {
  return t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
}

function Email({ ctx, t }: { ctx: RoleChangedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      cta={{ label: tt(t, ctx, "cta"), href: ctx.projectUrl }}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<RoleChangedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
