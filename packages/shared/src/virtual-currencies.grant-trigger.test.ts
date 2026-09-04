import { describe, expect, test } from "vitest";
import {
  grantTriggerMatches,
  grantTriggersMatching,
  type CurrencyGrantTrigger,
  type GrantEventTrigger,
} from "./virtual-currencies";

describe("grantTriggerMatches", () => {
  const cases: Array<[CurrencyGrantTrigger, GrantEventTrigger, boolean]> = [
    ["PURCHASE", "PURCHASE", true],
    ["PURCHASE", "RENEWAL", false],
    ["RENEWAL", "PURCHASE", false],
    ["RENEWAL", "RENEWAL", true],
    ["BOTH", "PURCHASE", true],
    ["BOTH", "RENEWAL", true],
  ];

  test.each(cases)(
    "grantOn=%s trigger=%s -> %s",
    (grantOn, trigger, expected) => {
      expect(grantTriggerMatches(grantOn, trigger)).toBe(expected);
    },
  );

  test("grantTriggersMatching is the inverse of grantTriggerMatches", () => {
    // The repository builds its SQL filter from this. If the two ever
    // disagree, grants silently fire on the wrong events.
    expect(grantTriggersMatching("PURCHASE").sort()).toEqual(["BOTH", "PURCHASE"]);
    expect(grantTriggersMatching("RENEWAL").sort()).toEqual(["BOTH", "RENEWAL"]);
  });

  test("an unknown grantOn never matches", () => {
    // Defensive: a row written by a newer build, read by an older one.
    // Granting on an unrecognised trigger would move real money.
    expect(
      grantTriggerMatches("SOMETHING_NEW" as CurrencyGrantTrigger, "RENEWAL"),
    ).toBe(false);
  });
});
