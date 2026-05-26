import type { TFunction } from "i18next";
import { SimpleAlert } from "../layouts/simple-alert";
import type { TemplateModule } from "../registry";

export interface RemovedCtx {
  projectId: string;
  projectName: string;
  removedByName: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

const NS = "team.removed";

function tt(t: TFunction, ctx: RemovedCtx, k: string): string {
  return t(`${NS}:${k}`, ctx as unknown as Record<string, unknown>) as string;
}

function Email({ ctx, t }: { ctx: RemovedCtx; t: TFunction }) {
  return (
    <SimpleAlert
      t={t}
      preview={tt(t, ctx, "preview")}
      headline={tt(t, ctx, "headline")}
      body={tt(t, ctx, "body")}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    />
  );
}

export const template: TemplateModule<RemovedCtx> = {
  Component: Email,
  subject: (ctx, t) => tt(t, ctx, "subject"),
  pushTitle: () => "",
  pushBody: () => "",
};
