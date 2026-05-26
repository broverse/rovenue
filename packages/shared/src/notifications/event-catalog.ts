import { z } from "zod";
import type { NotificationEventDescriptor } from "./types";

const moneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().length(3),
});

const projectSection = z.object({
  projectId: z.string().min(1),
  projectName: z.string(),
  mrr: z.number(),
  mrrDelta: z.number(),
  newSubs: z.number().int(),
  churnedSubs: z.number().int(),
  refundCount: z.number().int(),
  refundTotalCents: z.number().int(),
});

export const EVENT_CATALOG: Record<string, NotificationEventDescriptor> = {
  "revenue.digest.daily": {
    key: "revenue.digest.daily",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      date: z.string(),
      timezone: z.string(),
      sections: z.array(projectSection).min(1),
    }),
  },
  "revenue.digest.weekly": {
    key: "revenue.digest.weekly",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      weekStart: z.string(),
      weekEnd: z.string(),
      timezone: z.string(),
      sections: z.array(projectSection).min(1),
    }),
  },
  "revenue.anomaly.detected": {
    key: "revenue.anomaly.detected",
    category: "revenue",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "GROWTH"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      metric: z.enum(["mrr", "subs", "churn"]),
      direction: z.enum(["up", "down"]),
      magnitudePct: z.number(),
      windowMinutes: z.number().int(),
    }),
  },
  "revenue.milestone.hit": {
    key: "revenue.milestone.hit",
    category: "revenue",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: false,
    recipientScope: { kind: "project_members" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      milestone: moneySchema,
      metric: z.enum(["mrr", "total_revenue"]),
    }),
  },
  "revenue.churn.spike": {
    key: "revenue.churn.spike",
    category: "revenue",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "GROWTH"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      churnRatePct: z.number(),
      baselinePct: z.number(),
      windowDays: z.number().int(),
    }),
  },
  "billing.refund.detected": {
    key: "billing.refund.detected",
    category: "billing",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      amount: moneySchema,
      reason: z.enum(["high_value", "burst"]),
      productId: z.string().optional(),
    }),
  },
  "billing.credit.low_balance": {
    key: "billing.credit.low_balance",
    category: "billing",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      balanceCents: z.number().int(),
      thresholdCents: z.number().int(),
    }),
  },
  "billing.invoice.failed": {
    key: "billing.invoice.failed",
    category: "billing",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "workspace_owner" },
    pushAllowed: true,
    contextSchema: z.object({
      invoiceId: z.string(),
      amount: moneySchema,
      reason: z.string(),
      hostedInvoiceUrl: z.string().url().optional(),
    }),
  },
  "billing.invoice.paid": {
    key: "billing.invoice.paid",
    category: "billing",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: false,
    recipientScope: { kind: "workspace_owner" },
    pushAllowed: false,
    contextSchema: z.object({
      invoiceId: z.string(),
      amount: moneySchema,
      periodStart: z.string(),
      periodEnd: z.string(),
      hostedInvoiceUrl: z.string().url().optional(),
    }),
  },
  "integration.store_credential.expired": {
    key: "integration.store_credential.expired",
    category: "integration",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "DEVELOPER"] },
    pushAllowed: true,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      provider: z.enum(["apple", "google", "stripe"]),
      expiresAt: z.string().optional(),
    }),
  },
  "integration.webhook.failing": {
    key: "integration.webhook.failing",
    category: "integration",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "project_roles", roles: ["OWNER", "ADMIN", "DEVELOPER"] },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      webhookId: z.string().min(1),
      endpointUrl: z.string().url(),
      consecutiveFailures: z.number().int(),
    }),
  },
  "team.member.invited": {
    key: "team.member.invited",
    category: "team",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      inviterName: z.string(),
      role: z.string(),
      acceptUrl: z.string().url(),
    }),
  },
  "team.member.role_changed": {
    key: "team.member.role_changed",
    category: "team",
    defaultChannels: ["email", "inapp"],
    forcedChannels: [],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      oldRole: z.string(),
      newRole: z.string(),
      changedByName: z.string(),
    }),
  },
  "team.member.removed": {
    key: "team.member.removed",
    category: "team",
    defaultChannels: ["email"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      projectId: z.string().min(1),
      projectName: z.string(),
      removedByName: z.string(),
    }),
  },
  "security.signin.new_device": {
    key: "security.signin.new_device",
    category: "security",
    defaultChannels: ["email", "push", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: true,
    contextSchema: z.object({
      userAgent: z.string(),
      ipAddress: z.string(),
      approxLocation: z.string().optional(),
      whenIso: z.string(),
    }),
  },
  "security.oauth.account_linked": {
    key: "security.oauth.account_linked",
    category: "security",
    defaultChannels: ["email", "inapp"],
    forcedChannels: ["email"],
    defaultEnabled: true,
    recipientScope: { kind: "self" },
    pushAllowed: false,
    contextSchema: z.object({
      provider: z.enum(["github", "google"]),
      whenIso: z.string(),
    }),
  },
};

export function getEvent(key: string): NotificationEventDescriptor {
  const e = EVENT_CATALOG[key];
  if (!e) throw new Error(`unknown event key: ${key}`);
  return e;
}

export function listEventKeysByCategory(
  category: NotificationEventDescriptor["category"],
): string[] {
  return Object.values(EVENT_CATALOG)
    .filter((e) => e.category === category)
    .map((e) => e.key);
}
