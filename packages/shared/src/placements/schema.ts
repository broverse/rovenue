import { z } from "zod";

// =============================================================
// Placement targeting — discriminated union on "type"
// =============================================================

export const placementTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paywall"), paywallId: z.string().min(1) }),
  z.object({ type: z.literal("experiment"), experimentId: z.string().min(1) }),
  z.object({ type: z.literal("none") }),
]);

export type PlacementTarget = z.infer<typeof placementTargetSchema>;

// =============================================================
// Placement row — audience + target
// =============================================================

export const placementRowSchema = z.object({
  audienceId: z.string().min(1).nullable(),
  target: placementTargetSchema,
});

export type PlacementRow = z.infer<typeof placementRowSchema>;

// =============================================================
// Placement rows — array with refinements
// =============================================================

export const placementRowsSchema = z
  .array(placementRowSchema)
  .superRefine((rows, ctx) => {
    const nullIdx = rows.findIndex((r) => r.audienceId === null);
    const nullCount = rows.filter((r) => r.audienceId === null).length;
    if (nullCount > 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at most one all-users row" });
    if (nullCount === 1 && nullIdx !== rows.length - 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "all-users row must be last" });
  });

export type PlacementRows = z.infer<typeof placementRowsSchema>;
