import { z } from "zod";

// =============================================================
// Experiment types
// =============================================================
//
// Rovenue exposes four experiment kinds and they all share the
// same backend machinery (bucketing, targeting, assignment logs).
// The only thing that differs per type is what the SDK does with
// `variant.value` at the call site:
//
//   FLAG     → boolean | string | number | null
//   OFFERING → offering identifier (string)
//   PAYWALL  → structured remote config (see PaywallConfig)
//   ELEMENT  → arbitrary small object, one shape per experiment
//
// The engine treats `variant.value` as opaque JSON. It never
// introspects the shape — consumers cast it through a generic at
// the SDK boundary so each call site stays type-safe without
// leaking per-experiment shape into the backend.

export const EXPERIMENT_TYPE = {
  FLAG: "FLAG",
  OFFERING: "OFFERING",
  PAYWALL: "PAYWALL",
  ELEMENT: "ELEMENT",
} as const;

export type ExperimentType =
  (typeof EXPERIMENT_TYPE)[keyof typeof EXPERIMENT_TYPE];

// =============================================================
// Schemas
// =============================================================

const WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * A single experiment variant. `value` is `unknown` on purpose —
 * the engine does not constrain the shape.
 */
export const variantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.unknown(),
  weight: z.number().min(0).max(1),
});

export type Variant = z.infer<typeof variantSchema>;

/**
 * Raw object schema without the custom refinements. Exported so
 * dashboard routes can use `.pick` / `.shape` to reuse individual
 * fields — the refined `experimentSchema` is a `ZodEffects` and
 * doesn't expose those.
 */
export const experimentObjectSchema = z.object({
  type: z.enum([
    EXPERIMENT_TYPE.FLAG,
    EXPERIMENT_TYPE.OFFERING,
    EXPERIMENT_TYPE.PAYWALL,
    EXPERIMENT_TYPE.ELEMENT,
  ]),
  key: z.string().min(1),
  variants: z
    .array(variantSchema)
    .min(2, { message: "experiment must have at least 2 variants" }),
});

export const experimentSchema = experimentObjectSchema
  .superRefine((data, ctx) => {
    const sum = data.variants.reduce((acc, v) => acc + v.weight, 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `variant weights must sum to 1 (got ${sum})`,
        path: ["variants"],
      });
    }

    const seen = new Set<string>();
    for (let i = 0; i < data.variants.length; i += 1) {
      const variant = data.variants[i]!;
      if (seen.has(variant.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate variant id: ${variant.id}`,
          path: ["variants", i, "id"],
        });
      }
      seen.add(variant.id);
    }

    // Every arm must receive some traffic. A 0-weight variant is never
    // shown to anyone (selectVariant gives it an empty bucket range), so
    // it silently drops out of the test — a misconfiguration, not a split.
    data.variants.forEach((variant, i) => {
      if (variant.weight === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `variant "${variant.id}" has 0 weight — every variant must receive traffic`,
          path: ["variants", i, "weight"],
        });
      }
    });

    // Variants must actually differ — otherwise the experiment compares
    // identical treatments and can never produce a meaningful result.
    //   OFFERING → each offering may appear at most once (a repeated
    //              offering is always a mistake; the value space is large).
    //   others   → reject only a wholly-identical set, since a value space
    //              like FLAG-boolean legitimately can't be all-distinct.
    const serialized = data.variants.map((v) => JSON.stringify(v.value ?? null));
    if (data.type === EXPERIMENT_TYPE.OFFERING) {
      const seenValues = new Set<string>();
      data.variants.forEach((variant, i) => {
        const fingerprint = serialized[i]!;
        if (seenValues.has(fingerprint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate offering across variants: ${String(variant.value)}`,
            path: ["variants", i, "value"],
          });
        }
        seenValues.add(fingerprint);
      });
    } else if (
      data.variants.length > 0 &&
      serialized.every((s) => s === serialized[0])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "all variants have identical values — the experiment has nothing to compare",
        path: ["variants"],
      });
    }
  });

export type Experiment = z.infer<typeof experimentSchema>;

// =============================================================
// SDK-facing helper types
// =============================================================
//
// These are pure TypeScript shapes used at SDK call sites — they
// are NOT enforced by the backend schema. Consumers cast the
// opaque `variant.value` through them via the SDK's generic
// helpers (`useFlag<T>`, `usePaywallConfig`, `useExperimentValue<T>`).

/** Values a FLAG experiment typically returns. */
export type FlagValue = boolean | string | number | null;

/** Canonical PAYWALL remote config shape. SDK + dashboard share it. */
export interface PaywallConfig {
  title: string;
  subtitle: string;
  ctaText: string;
  ctaColor: string;
  layout: "vertical" | "horizontal";
  showBadge: boolean;
  badgeText?: string;
  backgroundImage: string | null;
  showTestimonial: boolean;
}
