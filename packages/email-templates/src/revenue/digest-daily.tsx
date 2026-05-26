import { Button, Heading, Hr, Section, Text } from "@react-email/components";
import type { TFunction } from "i18next";
import { BaseLayout } from "../layouts/base-layout";
import { formatCents, formatSignedPercent } from "../lib/money";
import type { TemplateModule } from "../registry";

export interface DigestDailyProjectSection {
  projectId: string;
  projectName: string;
  mrr: number;
  mrrDelta: number;
  newSubs: number;
  churnedSubs: number;
  refundCount: number;
  refundTotalCents: number;
  /** ISO currency for refund total (defaults to USD if absent). */
  currency?: string;
}

export interface DigestDailyCtx {
  date: string;
  timezone: string;
  sections: DigestDailyProjectSection[];
  dashboardUrl: string;
  managePreferencesUrl: string;
  unsubscribeUrl?: string;
  locale?: string;
}

const NS = "revenue.digest-daily";

const sectionStyle = {
  borderTop: "1px solid #e5e7eb",
  paddingTop: 12,
  marginTop: 12,
} as const;
const projectNameStyle = { fontWeight: 600, margin: 0 } as const;
const metricRowStyle = { fontSize: 14, margin: "4px 0", color: "#374151" } as const;
const buttonStyle = {
  background: "#111",
  color: "white",
  padding: "10px 16px",
  borderRadius: 6,
  marginTop: 16,
} as const;

function Email({ ctx, t }: { ctx: DigestDailyCtx; t: TFunction }) {
  const locale = ctx.locale ?? "en";
  const interp = { ...ctx, count: ctx.sections.length } as unknown as Record<
    string,
    unknown
  >;
  const tt = (k: string, extra?: Record<string, unknown>) =>
    t(`${NS}:${k}`, { ...interp, ...(extra ?? {}) }) as string;

  return (
    <BaseLayout
      t={t}
      preview={tt("preview")}
      managePreferencesUrl={ctx.managePreferencesUrl}
      unsubscribeUrl={ctx.unsubscribeUrl}
    >
      <Heading>{tt("headline")}</Heading>
      <Text>{tt("intro")}</Text>

      {ctx.sections.map((s) => (
        <Section key={s.projectId} style={sectionStyle}>
          <Text style={projectNameStyle}>{s.projectName}</Text>
          <Text style={metricRowStyle}>
            {tt("section.mrr")}: {formatCents(Math.round(s.mrr * 100), s.currency ?? "USD", locale)}
            {" · "}
            {tt("section.mrrDelta")}: {formatSignedPercent(s.mrrDelta, locale)}
          </Text>
          <Text style={metricRowStyle}>
            {tt("section.newSubs")}: {s.newSubs} · {tt("section.churnedSubs")}: {s.churnedSubs}
          </Text>
          <Text style={metricRowStyle}>
            {tt("section.refunds")}:{" "}
            {tt("section.refundsValue", {
              count: s.refundCount,
              total: formatCents(s.refundTotalCents, s.currency ?? "USD", locale),
            })}
          </Text>
        </Section>
      ))}

      <Hr style={{ borderColor: "#e5e7eb", marginTop: 16 }} />
      <Button href={ctx.dashboardUrl} style={buttonStyle}>
        {tt("cta")}
      </Button>
    </BaseLayout>
  );
}

export const template: TemplateModule<DigestDailyCtx> = {
  Component: Email,
  subject: (ctx, t) =>
    t(`${NS}:subject`, ctx as unknown as Record<string, unknown>) as string,
  pushTitle: () => "",
  pushBody: () => "",
};
