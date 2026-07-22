import { describe, expect, it } from "vitest";

import { UNIQUE_VIOLATION, isUniqueViolation, isUniqueViolationOf } from "./pg-errors";

// =============================================================
// pg-errors
// =============================================================
//
// The whole point of these helpers is that the interesting fields are
// NOT on the object you catch. So the tests are mostly about shapes:
// the real wrapped shape must match, and everything that is merely
// error-adjacent must not — because "no match" is what makes a caller
// rethrow instead of swallowing something it never identified.

/** A `pg` unique-violation error, as the driver actually produces it. */
function pgUniqueViolation(constraint: string): Error & Record<string, unknown> {
  const err = new Error(
    `duplicate key value violates unique constraint "${constraint}"`,
  ) as Error & Record<string, unknown>;
  err.code = UNIQUE_VIOLATION;
  err.constraint = constraint;
  err.severity = "ERROR";
  err.table = "some_table";
  return err;
}

/**
 * The shape Drizzle 0.45.2 actually throws: a `DrizzleQueryError` whose
 * message is the failed query and whose `.cause` is the driver error.
 * Reconstructed rather than imported so the test still fails loudly if
 * drizzle's wrapping changes shape rather than silently following it.
 */
function drizzleWrapped(cause: unknown): Error {
  const err = new Error(
    'Failed query: insert into "some_table" ...\nparams: a,b',
  ) as Error & { query: string; params: unknown[] };
  err.query = 'insert into "some_table" ...';
  err.params = ["a", "b"];
  err.cause = cause;
  return err;
}

describe("isUniqueViolationOf", () => {
  it("matches a unique violation wrapped in the real DrizzleQueryError shape", () => {
    const err = drizzleWrapped(pgUniqueViolation("widgets_name_unique"));

    // The regression this whole module exists for: the top level has
    // neither field, so a naive check reads undefined and never matches.
    expect((err as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(true);
  });

  it("does not match a unique violation of a DIFFERENT constraint", () => {
    const err = drizzleWrapped(pgUniqueViolation("widgets_slug_unique"));

    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(false);
    // ...though it is still a unique violation.
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("does not match when code and constraint come from different links", () => {
    // A wrapper that happens to carry the constraint name, over a cause
    // that happens to carry the code, is not evidence of anything: the
    // conjunction has to hold on one link.
    const inner = new Error("some other failure") as Error & { code: string };
    inner.code = UNIQUE_VIOLATION;
    const outer = new Error("wrapper") as Error & { constraint: string };
    outer.constraint = "widgets_name_unique";
    outer.cause = inner;

    expect(isUniqueViolationOf(outer, "widgets_name_unique")).toBe(false);
  });

  it("finds the match on a deeply nested but in-bounds cause chain", () => {
    const err = drizzleWrapped(
      new Error("retry wrapper", { cause: pgUniqueViolation("widgets_name_unique") }),
    );

    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(true);
  });

  it("gives up past the depth bound rather than walking forever", () => {
    // Depth bound is 5 links. Bury the driver error under 6 wrappers and
    // it must fall out of range — failing closed, not throwing.
    let err: unknown = pgUniqueViolation("widgets_name_unique");
    for (let i = 0; i < 6; i += 1) err = new Error(`wrapper ${i}`, { cause: err });

    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("matches on the code alone, whatever the constraint", () => {
    expect(isUniqueViolation(drizzleWrapped(pgUniqueViolation("anything_at_all")))).toBe(
      true,
    );
  });

  it("matches a bare, unwrapped driver error", () => {
    // Not every caller is behind drizzle's wrapper — raw pg clients and
    // hand-rolled test doubles throw the driver error directly.
    const err = pgUniqueViolation("widgets_name_unique");

    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(true);
  });

  it("does not match a different SQLSTATE", () => {
    const err = new Error("deadlock detected") as Error & { code: string };
    err.code = "40P01";

    expect(isUniqueViolation(drizzleWrapped(err))).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    // A cycle is the reason the bound exists at all: without it this
    // call never returns.
    const err = new Error("cyclic") as Error & { cause?: unknown };
    err.cause = err;

    expect(isUniqueViolation(err)).toBe(false);
    expect(isUniqueViolationOf(err, "widgets_name_unique")).toBe(false);
  });

  it("terminates on a two-link cycle that never carries the code", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    expect(isUniqueViolation(a)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["a number", 23505],
    ["a boolean", false],
    ["a plain object with no code", { message: "nope" }],
  ])("returns false (does not throw) for %s", (_label, thrown) => {
    expect(() => isUniqueViolation(thrown)).not.toThrow();
    expect(isUniqueViolation(thrown)).toBe(false);
    expect(isUniqueViolationOf(thrown, "widgets_name_unique")).toBe(false);
  });

  it("returns false for a null cause part-way down the chain", () => {
    expect(isUniqueViolation(drizzleWrapped(null))).toBe(false);
    expect(isUniqueViolation(drizzleWrapped(undefined))).toBe(false);
  });

  it("does not mistake the string '23505' in a message for the code", () => {
    const err = drizzleWrapped(new Error("SQLSTATE 23505 happened somewhere"));

    expect(isUniqueViolation(err)).toBe(false);
  });
});
