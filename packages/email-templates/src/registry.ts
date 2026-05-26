import { render } from "@react-email/render";
import { createElement, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { getT } from "./i18n";
import { template as anomalyDetected } from "./revenue/anomaly-detected";
import { template as digestDaily } from "./revenue/digest-daily";
import { template as digestWeekly } from "./revenue/digest-weekly";
import { template as churnSpike } from "./revenue/churn-spike";

export interface TemplateModule<Ctx> {
  Component: (props: { ctx: Ctx; t: TFunction }) => ReactElement;
  subject: (ctx: Ctx, t: TFunction) => string;
  pushTitle: (ctx: Ctx, t: TFunction) => string;
  pushBody: (ctx: Ctx, t: TFunction) => string;
}

// Templates are looked up at runtime by event key; Ctx is validated upstream
// by the event catalog's contextSchema (see packages/shared/notifications).
const TEMPLATES: Record<string, TemplateModule<any>> = {
  "revenue.anomaly.detected": anomalyDetected,
  "revenue.digest.daily": digestDaily,
  "revenue.digest.weekly": digestWeekly,
  "revenue.churn.spike": churnSpike,
  // More templates land in Phase 6.
};

export interface RenderInput {
  eventKey: string;
  locale: string;
  context: Record<string, unknown>;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
}

export interface RenderOutput {
  subject: string;
  html: string;
  text: string;
  pushTitle: string;
  pushBody: string;
}

export function hasTemplate(eventKey: string): boolean {
  return Object.hasOwn(TEMPLATES, eventKey);
}

export function registeredEventKeys(): string[] {
  return Object.keys(TEMPLATES);
}

export async function renderTemplate(
  input: RenderInput,
): Promise<RenderOutput> {
  const mod = TEMPLATES[input.eventKey];
  if (!mod) throw new Error(`no template for event ${input.eventKey}`);
  const t = getT(input.locale);
  const ctx = {
    ...input.context,
    managePreferencesUrl: input.managePreferencesUrl,
    unsubscribeUrl: input.unsubscribeUrl,
  };
  const element = createElement(mod.Component, { ctx, t });
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return {
    subject: mod.subject(ctx, t),
    html,
    text,
    pushTitle: mod.pushTitle(ctx, t),
    pushBody: mod.pushBody(ctx, t),
  };
}
