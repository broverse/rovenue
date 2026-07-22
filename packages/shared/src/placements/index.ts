// =============================================================
// Placements — paywall row schema and targeting
// =============================================================
//
// A placement row maps an audience (or null for all-users) to a
// target (paywall, experiment, or none). Rows are ordered in the
// order they will be evaluated, with the all-users row (if present)
// always at the end as a fallback.

export {
  placementTargetSchema,
  type PlacementTarget,
  placementRowSchema,
  type PlacementRow,
  placementRowsSchema,
  type PlacementRows,
} from "./schema";
