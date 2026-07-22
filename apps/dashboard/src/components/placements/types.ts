import type {
  DashboardPlacementRow,
  PlacementRow,
  PlacementTarget,
} from "@rovenue/shared";

/**
 * UI alias for the wire row — mirrors paywalls/types.ts (`Paywall`):
 * placements are simple enough that the API row doubles as the view
 * model, no derived fields needed.
 */
export type Placement = DashboardPlacementRow;

export type { PlacementRow, PlacementTarget };

/** Segmented target-type — the discriminant of `PlacementTarget`. */
export type PlacementTargetType = PlacementTarget["type"];

export const PLACEMENT_TARGET_TYPES: ReadonlyArray<PlacementTargetType> = [
  "paywall",
  "experiment",
  "none",
];
