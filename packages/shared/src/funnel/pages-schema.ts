import { z } from "zod";
import { nextRuleSchema } from "./branching-schema";

const baseFields = {
  id: z.string().min(1),
  next_rules: z.array(nextRuleSchema).optional(),
  default_next: z.union([z.string(), z.literal("paywall"), z.literal("end")]).optional(),
};

const questionSingleConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        value: z.string().min(1),
        icon: z.string().optional(),
      }),
    )
    .min(1),
  required: z.boolean().optional(),
});

const questionMultiConfig = questionSingleConfig.extend({
  max_selections: z.number().int().positive().optional(),
});

const textInputConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  placeholder: z.string().optional(),
  validation: z.enum(["text", "email", "url"]).default("text"),
  required: z.boolean().optional(),
});

const numberInputConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  suffix: z.string().optional(),
});

const dateConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min_date: z.string().optional(),
  max_date: z.string().optional(),
});

const sliderConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  label_format: z.string().optional(),
});

const ratingConfig = z.object({
  question_id: z.string().min(1),
  title: z.string().min(1),
  scale: z.union([z.literal(5), z.literal(10)]),
  icon: z.enum(["star", "heart"]).default("star"),
});

const infoConfig = z.object({
  title: z.string().min(1),
  body_markdown: z.string(),
  image_url: z.string().url().optional(),
  cta_label: z.string().optional(),
});

const loadingConfig = z.object({
  title: z.string().min(1),
  duration_ms: z.number().int().min(500).max(15000),
  steps: z.array(z.string()).optional(),
});

const resultConfig = z.object({
  title_template: z.string(),
  body_template: z.string(),
});

const paywallConfig = z.object({
  product_id: z.string().min(1),
  trial: z.object({ days: z.union([z.literal(3), z.literal(7)]) }).optional(),
  headline: z.string().min(1),
  bullets: z.array(z.string()).min(1),
});

const successConfig = z.object({
  headline: z.string().min(1),
  body: z.string(),
  open_app_label: z.string().min(1),
});

export const pageSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("question_single"), config: questionSingleConfig }),
  z.object({ ...baseFields, type: z.literal("question_multi"), config: questionMultiConfig }),
  z.object({ ...baseFields, type: z.literal("text_input"), config: textInputConfig }),
  z.object({ ...baseFields, type: z.literal("number_input"), config: numberInputConfig }),
  z.object({ ...baseFields, type: z.literal("date"), config: dateConfig }),
  z.object({ ...baseFields, type: z.literal("slider"), config: sliderConfig }),
  z.object({ ...baseFields, type: z.literal("rating"), config: ratingConfig }),
  z.object({ ...baseFields, type: z.literal("info"), config: infoConfig }),
  z.object({ ...baseFields, type: z.literal("loading"), config: loadingConfig }),
  z.object({ ...baseFields, type: z.literal("result"), config: resultConfig }),
  z.object({ ...baseFields, type: z.literal("paywall"), config: paywallConfig }),
  z.object({ ...baseFields, type: z.literal("success"), config: successConfig }),
]);

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
