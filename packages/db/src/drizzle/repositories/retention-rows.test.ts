import { describe, expect, it } from "vitest";
import { RETENTION_POLICIES } from "@rovenue/shared/retention";
import { hasDeleteRowsMapping } from "./retention-rows";

// A missing mapping here is otherwise loud only at runtime — as an
// identical `deleteRetentionRowsOlderThan: unknown DELETE_ROWS table`
// error, once per project, every night. This pins the gap to CI
// instead: a new DELETE_ROWS policy added to the registry
// (@rovenue/shared/retention) without a matching entry in this
// module's DELETE_ROWS_TABLES map fails here, not at 2am.
describe("DELETE_ROWS table registry", () => {
  it("has a mapping for every DELETE_ROWS policy in RETENTION_POLICIES", () => {
    const deleteRowsPolicies = RETENTION_POLICIES.filter(
      (policy) => policy.strategy === "DELETE_ROWS",
    );

    // Guards the guard: if this ever comes back empty, the test below
    // would vacuously pass having checked nothing.
    expect(deleteRowsPolicies.length).toBeGreaterThan(0);

    for (const policy of deleteRowsPolicies) {
      expect(hasDeleteRowsMapping(policy.table)).toBe(true);
    }
  });
});
