import type { PlacementRow, PlacementTarget } from "@rovenue/shared";

// =============================================================
// Pure helpers backing placement-editor.tsx / row-card.tsx
// =============================================================
//
// Kept dependency-free (no React) so they're unit-testable in
// isolation — see __tests__/placement-rows-utils.test.ts. Mirrors
// the shape the API's `placementRowsSchema` enforces server-side
// (packages/shared/src/placements/schema.ts): at most one row may
// carry `audienceId: null` ("All users"), and when present it must
// be the last row. `moveRow`/`addRow` never produce a rows array
// that trips that server-side refinement; `validatePlacementRows`
// is the pre-submit safety net for everything else (unset selects,
// incomplete targets) the UI can otherwise let slip through.

/** A fresh, unconfigured row: no audience picked yet, no target. */
export function makeEmptyRow(): PlacementRow {
  return { audienceId: "", target: { type: "none" } };
}

/**
 * Appends a new empty row. If the list currently ends with the
 * "All users" fallback row (`audienceId: null`), the new row is
 * inserted *before* it so the fallback stays last — matching the
 * server's "all-users row must be last" refinement.
 */
export function addRow(rows: ReadonlyArray<PlacementRow>): PlacementRow[] {
  const last = rows[rows.length - 1];
  if (last && last.audienceId === null) {
    return [...rows.slice(0, -1), makeEmptyRow(), last];
  }
  return [...rows, makeEmptyRow()];
}

export function removeRow(
  rows: ReadonlyArray<PlacementRow>,
  index: number,
): PlacementRow[] {
  return rows.filter((_, i) => i !== index);
}

/**
 * Swaps row `index` with its upper/lower neighbor. No-op (returns
 * the same array reference) when the move would go out of bounds —
 * callers can use reference equality to skip a re-render if they
 * want, though none currently do.
 */
export function moveRow(
  rows: ReadonlyArray<PlacementRow>,
  index: number,
  direction: "up" | "down",
): PlacementRow[] {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) {
    return [...rows];
  }
  const next = [...rows];
  const tmp = next[index]!;
  next[index] = next[target]!;
  next[target] = tmp;
  return next;
}

export function setRowAudience(
  rows: ReadonlyArray<PlacementRow>,
  index: number,
  audienceId: string | null,
): PlacementRow[] {
  return rows.map((r, i) => (i === index ? { ...r, audienceId } : r));
}

export function setRowTarget(
  rows: ReadonlyArray<PlacementRow>,
  index: number,
  target: PlacementTarget,
): PlacementRow[] {
  return rows.map((r, i) => (i === index ? { ...r, target } : r));
}

/** The "All users" pseudo-option is only ever valid on the last row. */
export function canRowBeAllUsers(
  rows: ReadonlyArray<PlacementRow>,
  index: number,
): boolean {
  return index === rows.length - 1;
}

export type PlacementRowValidationErrorCode =
  | "AUDIENCE_UNSET"
  | "TARGET_INCOMPLETE"
  | "ALL_USERS_NOT_LAST"
  | "DUPLICATE_ALL_USERS";

export interface PlacementRowValidationError {
  code: PlacementRowValidationErrorCode;
  index: number;
}

/**
 * Client-side mirror of `placementRowsSchema`'s refinements plus the
 * "every select is actually filled in" checks the server also does
 * (`audienceId`/`paywallId`/`experimentId` all reject empty
 * strings). Returns the first violation found, or `null` when the
 * rows are submit-ready. Order matches how a user would fix issues
 * top-to-bottom: the all-users placement rule first (it's
 * structural), then per-row completeness.
 */
export function validatePlacementRows(
  rows: ReadonlyArray<PlacementRow>,
): PlacementRowValidationError | null {
  const allUsersIndices = rows
    .map((r, i) => (r.audienceId === null ? i : -1))
    .filter((i) => i >= 0);

  if (allUsersIndices.length > 1) {
    return { code: "DUPLICATE_ALL_USERS", index: allUsersIndices[1]! };
  }
  if (allUsersIndices.length === 1 && allUsersIndices[0] !== rows.length - 1) {
    return { code: "ALL_USERS_NOT_LAST", index: allUsersIndices[0]! };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.audienceId !== null && row.audienceId.trim().length === 0) {
      return { code: "AUDIENCE_UNSET", index: i };
    }
    if (row.target.type === "paywall" && row.target.paywallId.trim().length === 0) {
      return { code: "TARGET_INCOMPLETE", index: i };
    }
    if (
      row.target.type === "experiment" &&
      row.target.experimentId.trim().length === 0
    ) {
      return { code: "TARGET_INCOMPLETE", index: i };
    }
  }

  return null;
}
