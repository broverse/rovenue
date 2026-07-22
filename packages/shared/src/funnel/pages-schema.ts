import { z } from "zod";
import { nextRuleSchema } from "./branching-schema";

// =============================================================
// Funnel page schema — flat dashboard shape.
//
// This package no longer feeds native mobile SDKs (Rust core /
// Swift / Kotlin / RN are out of scope for funnels). The only
// consumer is the API: publish-time validation + the server-side
// branching evaluator/validator. So the schema mirrors what the
// dashboard actually saves under `funnels.draft_pages_json`:
// a single flat object per page, fields top-level, no `config`
// wrapper. See apps/dashboard/src/components/funnel-builder/types.ts
// (Page interface, ~line 210) for the canonical shape.
//
// Validation here is intentionally permissive — every field is
// optional except `id` and `type`. The dashboard UI enforces
// per-type field requirements (required body for statement,
// options for choice pages, etc.) before save. The server uses
// `validateFunnelGraph` for the cross-page invariants that
// actually matter (at-least-one paywall + success, no cycles,
// no dangling refs, reachability).
// =============================================================

export const PAGE_TYPES = [
  "single_choice",
  "multi_choice",
  "text_input",
  "number_input",
  "date_input",
  "slider",
  "rating",
  "info",
  "loading",
  "result",
  "paywall",
  "success",
  "contact_info",
  "email",
  "phone",
  "picture_choice",
  "yes_no",
  "legal",
  "checkbox",
  "opinion_scale",
  "long_text",
  "short_text",
  "welcome",
  "statement",
  "feature",
  "end_screen",
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

const optionSchema = z.object({
  label: z.string(),
  value: z.string(),
  imageUrl: z.string().optional(),
});

const pageBackgroundSchema = z.object({
  kind: z.enum(["none", "color", "image", "video"]),
  value: z.string(),
  opacity: z.number(),
});

const pageFooterSchema = z.object({
  enabled: z.boolean(),
  bgColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().optional(),
  buttonColor: z.string().optional(),
});

// Single permissive flat object — discriminating on `type` only matters
// when the variants have meaningfully different shapes. The dashboard's
// page interface is a wide union of optional fields, so per-type Zod
// variants would just be 26 copies of the same object; not worth the
// code surface vs. UI-level validation.
export const pageSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(PAGE_TYPES),
    // Branching, inlined onto the page by the dashboard's `recomposePages`
    // (apps/dashboard/src/lib/services/funnel-api.ts) before save.
    next_rules: z.array(nextRuleSchema).optional(),
    default_next: z
      .union([z.string(), z.literal("paywall"), z.literal("end")])
      .optional(),
    // Shared fields
    question_id: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    body: z.string().optional(),
    cta: z.string().optional(),
    required: z.boolean().optional(),
    // Choice + picture_choice
    options: z.array(optionSchema).optional(),
    max_selections: z.number().optional(),
    // Numeric inputs / slider / rating / opinion_scale
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    suffix: z.string().optional(),
    format: z.string().optional(),
    // Loading
    duration: z.number().optional(),
    steps: z.array(z.string()).optional(),
    // Paywall / feature / success
    headline: z.string().optional(),
    productId: z.string().optional(),
    // Optional reference to a project paywall (packages/shared/src/paywall)
    // whose `builderConfig` should render this page via the shared
    // <PaywallRenderer> instead of the legacy flat fields above. See
    // apps/api/src/routes/dashboard/funnels.ts (publish gate) and
    // apps/api/src/routes/public/funnels.ts (serve hydration).
    paywallId: z.string().optional(),
    trial: z.number().optional(),
    benefits: z.array(z.string()).optional(),
    features: z.array(z.string()).optional(),
    // Media above content
    mediaKind: z.enum(["none", "image", "video"]).optional(),
    mediaUrl: z.string().optional(),
    // Text inputs
    placeholder: z.string().optional(),
    // contact_info sub-fields
    collectName: z.boolean().optional(),
    collectEmail: z.boolean().optional(),
    collectPhone: z.boolean().optional(),
    // legal / checkbox
    agreementLabel: z.string().optional(),
    termsUrl: z.string().optional(),
    // Per-page design overrides
    background: pageBackgroundSchema.optional(),
    footer: pageFooterSchema.optional(),
    showProgress: z.boolean().optional(),
    showBack: z.boolean().optional(),
    radius: z.number().optional(),
  })
  // Tolerant of dashboard fields we haven't enumerated yet — UI-level
  // validation owns the per-type contract.
  .passthrough();

export type Page = z.infer<typeof pageSchema>;

export const pagesArraySchema = z
  .array(pageSchema)
  .superRefine((pages, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < pages.length; i++) {
      const id = pages[i].id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `Duplicate page id: ${id}`,
        });
      }
      seen.add(id);
    }
  });

export type PagesArray = z.infer<typeof pagesArraySchema>;
