import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import * as t from "./schema";

// =============================================================
// drizzle-zod validators
// =============================================================
//
// Each table exposes a `selectSchema` + `insertSchema` pair derived
// from the Drizzle table definition. Scalar column refinements
// (length, regex, numeric range) are applied inline via the
// callback form so createInsertSchema can propagate them.
//
// Shape-level JSON contracts are exported as standalone schemas
// below (productStoreIdsSchema, experimentVariantsSchema, etc.) —
// drizzle-zod's JSON column override signature is awkward to type
// across zod 3/4 boundaries, so we keep JSON validation one level
// higher than the raw insert path. Route handlers compose them:
//
//   const body = productInsertSchema.parse(req.body);
//   const storeIds = productStoreIdsSchema.parse(body.storeIds);

// =============================================================
// user (Better Auth — we only read it here; no insert schema)
// =============================================================

export const userSelectSchema = createSelectSchema(t.user);

// =============================================================
// projects
// =============================================================

export const projectSelectSchema = createSelectSchema(t.projects);
export const projectInsertSchema = createInsertSchema(t.projects, {
  name: (s) => s.min(1).max(120),
  slug: (s) => s.regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
});

// =============================================================
// project_members
// =============================================================

export const projectMemberSelectSchema = createSelectSchema(t.projectMembers);
export const projectMemberInsertSchema = createInsertSchema(t.projectMembers);

// =============================================================
// api_keys
// =============================================================

export const apiKeySelectSchema = createSelectSchema(t.apiKeys);
export const apiKeyInsertSchema = createInsertSchema(t.apiKeys, {
  label: (s) => s.min(1).max(64),
});

// =============================================================
// products — with standalone storeIds / entitlementKeys schemas
// =============================================================

/**
 * Store-specific ids map: { apple, google, stripe } with at least
 * one member present. Route handlers call `.parse()` on the JSON
 * column after the insert schema passes shape validation.
 */
export const productStoreIdsSchema = z
  .object({
    apple: z.string().min(1).optional(),
    google: z.string().min(1).optional(),
    stripe: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "storeIds must include at least one store",
  });

export const productSelectSchema = createSelectSchema(t.products);
export const productInsertSchema = createInsertSchema(t.products, {
  identifier: (s) => s.regex(/^[a-z0-9][a-z0-9._-]*$/i),
  displayName: (s) => s.min(1).max(120),
});

// =============================================================
// product_groups
// =============================================================

/**
 * A paywall/product-group lists products with optional
 * display metadata. `order` drives UI sort order; `promoted`
 * flags the "best deal" badge.
 */
export const productGroupProductsSchema = z.array(
  z.object({
    productId: z.string().min(1),
    order: z.number().int().min(0).optional(),
    promoted: z.boolean().optional(),
  }),
);

export const productGroupSelectSchema = createSelectSchema(t.productGroups);
export const productGroupInsertSchema = createInsertSchema(t.productGroups, {
  identifier: (s) => s.regex(/^[a-z0-9][a-z0-9._-]*$/i),
});

// =============================================================
// subscribers
// =============================================================

export const subscriberSelectSchema = createSelectSchema(t.subscribers);
export const subscriberInsertSchema = createInsertSchema(t.subscribers, {
  appUserId: (s) => s.min(1).max(256),
});

// =============================================================
// purchases
// =============================================================

export const purchaseSelectSchema = createSelectSchema(t.purchases);
export const purchaseInsertSchema = createInsertSchema(t.purchases, {
  storeTransactionId: (s) => s.min(1),
  originalTransactionId: (s) => s.min(1),
});

// =============================================================
// subscriber_access
// =============================================================

export const subscriberAccessSelectSchema = createSelectSchema(
  t.subscriberAccess,
);
export const subscriberAccessInsertSchema = createInsertSchema(
  t.subscriberAccess,
  {
    entitlementKey: (s) => s.regex(/^[a-z0-9][a-z0-9_-]*$/i),
  },
);

// =============================================================
// credit_ledger (append-only)
// =============================================================

export const creditLedgerSelectSchema = createSelectSchema(t.creditLedger);
export const creditLedgerInsertSchema = createInsertSchema(t.creditLedger);

// =============================================================
// webhook_events
// =============================================================

export const webhookEventSelectSchema = createSelectSchema(t.webhookEvents);
export const webhookEventInsertSchema = createInsertSchema(t.webhookEvents);

// =============================================================
// outgoing_webhooks
// =============================================================

export const outgoingWebhookSelectSchema = createSelectSchema(
  t.outgoingWebhooks,
);
export const outgoingWebhookInsertSchema = createInsertSchema(
  t.outgoingWebhooks,
  {
    url: (s) => s.url(),
  },
);

// =============================================================
// revenue_events
// =============================================================

export const revenueEventSelectSchema = createSelectSchema(t.revenueEvents);
export const revenueEventInsertSchema = createInsertSchema(t.revenueEvents, {
  currency: (s) => s.length(3), // ISO 4217 three-letter code
});

// =============================================================
// audiences
// =============================================================

export const audienceSelectSchema = createSelectSchema(t.audiences);
export const audienceInsertSchema = createInsertSchema(t.audiences, {
  name: (s) => s.min(1).max(120),
});

// =============================================================
// experiments — with variant invariant schema
// =============================================================

/**
 * Variant shape validated end-to-end: weights sum to 1 (within
 * floating-point tolerance) and ids are unique. Route handlers
 * parse the `variants` JSON with this schema after the experiment
 * insertSchema validates the envelope.
 */
export const experimentVariantsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      value: z.unknown(),
      weight: z.number().min(0).max(1),
    }),
  )
  .superRefine((arr, ctx) => {
    const sum = arr.reduce((a, v) => a + v.weight, 0);
    if (Math.abs(sum - 1) > 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `variant weights must sum to 1 (got ${sum})`,
        path: ["variants"],
      });
    }
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i += 1) {
      if (seen.has(arr[i]!.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate variant id: ${arr[i]!.id}`,
          path: [i, "id"],
        });
      }
      seen.add(arr[i]!.id);
    }
  });

export const experimentSelectSchema = createSelectSchema(t.experiments);
export const experimentInsertSchema = createInsertSchema(t.experiments, {
  key: (s) => s.regex(/^[a-z0-9][a-z0-9_-]*$/i),
});

// =============================================================
// experiment_assignments
// =============================================================

export const experimentAssignmentSelectSchema = createSelectSchema(
  t.experimentAssignments,
);
export const experimentAssignmentInsertSchema = createInsertSchema(
  t.experimentAssignments,
);

// =============================================================
// feature_flags — with rule schema
// =============================================================

export const featureFlagRuleSchema = z.object({
  audienceId: z.string().min(1),
  value: z.unknown(),
  rolloutPercentage: z.number().min(0).max(1).nullish(),
});

export const featureFlagRulesSchema = z.array(featureFlagRuleSchema);

export const featureFlagSelectSchema = createSelectSchema(t.featureFlags);
export const featureFlagInsertSchema = createInsertSchema(t.featureFlags, {
  key: (s) => s.regex(/^[a-z0-9][a-z0-9_-]*$/i),
});

// =============================================================
// audit_logs
// =============================================================

export const auditLogSelectSchema = createSelectSchema(t.auditLogs);
export const auditLogInsertSchema = createInsertSchema(t.auditLogs);
