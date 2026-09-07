import type { Page, PageType } from "./pages-schema";
import type { ValidationResult, ValidatorIssue } from "./validator";

/**
 * Per-type required fields. `pages-schema.ts` is deliberately permissive
 * — only `id` and `type` are required — because the dashboard UI enforced
 * these before save. Now that a non-dashboard client can author funnels,
 * that enforcement has to exist on the server too, so it lives here and
 * runs at PUBLISH time (see design spec, D4). Saving an invalid page must
 * keep succeeding — this function is never called on save.
 *
 * A field earns a place in this table only when its absence makes the
 * page unanswerable or unrenderable — not merely unstyled or ugly. That
 * was checked against the actual page renderer,
 * `apps/dashboard/src/components/funnel-builder/page-preview.tsx`, which
 * also serves as the public funnel runner (its `chrome: "full"` mode).
 * Most page types have a real runtime fallback there and are fully
 * answerable without the field `blank-page.ts` merely seeds as a nice
 * starting default for the builder:
 *   - slider / opinion_scale / rating / number_input default their
 *     min/max/step (e.g. `page.min ?? 0`, `page.max ?? 100`).
 *   - yes_no falls back to a default Yes/No option pair
 *     (`page.options?.length === 2 ? page.options : [...]`).
 *   - legal / checkbox fall back to default agreement copy
 *     ("I agree") and never require a body — they don't have one.
 *   - contact_info defaults collectName/collectEmail to true unless
 *     explicitly `false`, so it always asks for at least two fields.
 *   - info / statement / welcome / feature / end_screen bodies and
 *     headlines are optional decoration; the page still renders a title
 *     (or the type's default label) and a CTA with nothing else set.
 *
 * The three choice types below have no such fallback: `options` is
 * rendered with `(page.options || [])` / `(page.options ?? [])` and
 * nothing substitutes for it, so an empty or missing array renders zero
 * rows — the page cannot be answered at all.
 *
 * A page type absent from this table has no required fields.
 */
const REQUIRED_FIELDS: Partial<Record<PageType, readonly string[]>> = {
  single_choice: ["options"],
  multi_choice: ["options"],
  picture_choice: ["options"],
};

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * Validates that every page carries the fields its type cannot render or
 * be answered without. Reuses `ValidationResult` so the publish route can
 * merge these issues with `validateFunnelGraph`'s cross-page checks into
 * one report.
 */
export function validatePageFields(pages: Page[]): ValidationResult {
  const issues: ValidatorIssue[] = [];

  for (const page of pages) {
    const required = REQUIRED_FIELDS[page.type];
    if (!required) continue;

    for (const field of required) {
      const value = (page as unknown as Record<string, unknown>)[field];
      if (isEmpty(value)) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          message: `Page "${page.id}" of type "${page.type}" is missing required field "${field}"`,
          pageId: page.id,
          field,
        });
      }
    }
  }

  return issues.length > 0
    ? { ok: false, issues, warnings: [] }
    : { ok: true, warnings: [] };
}
