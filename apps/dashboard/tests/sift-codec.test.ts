import { describe, expect, test } from "vitest";
import {
  conditionsToSift,
  siftToConditions,
  makeCondition,
  type DraftCondition,
} from "../src/components/targeting/sift-codec";

describe("sift-codec", () => {
  test("empty list serialises to undefined", () => {
    expect(conditionsToSift([])).toBeUndefined();
  });

  test("single country fragment", () => {
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listOp: "$in", listValues: ["TR", "DE"] },
    ];
    expect(conditionsToSift(conds)).toEqual({
      country: { $in: ["TR", "DE"] },
    });
  });

  test("multiple fragments wrapped in $and", () => {
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listOp: "$in", listValues: ["TR"] },
      {
        ...makeCondition("platform"),
        listOp: "$nin",
        listValues: ["web"],
      },
    ];
    expect(conditionsToSift(conds)).toEqual({
      $and: [
        { country: { $in: ["TR"] } },
        { platform: { $nin: ["web"] } },
      ],
    });
  });

  test("appVersion uses scalar op", () => {
    const conds: DraftCondition[] = [
      {
        ...makeCondition("appVersion"),
        scalarOp: "$gte",
        scalarValue: "1.2.3",
      },
    ];
    expect(conditionsToSift(conds)).toEqual({
      appVersion: { $gte: "1.2.3" },
    });
  });

  test("customAttribute parses scalars (number / bool / string)", () => {
    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "level",
          scalarOp: "$gte",
          scalarValue: "42",
        },
      ]),
    ).toEqual({ level: { $gte: 42 } });

    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "isPro",
          scalarOp: "$eq",
          scalarValue: "true",
        },
      ]),
    ).toEqual({ isPro: { $eq: true } });

    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "plan",
          scalarOp: "$eq",
          scalarValue: "premium",
        },
      ]),
    ).toEqual({ plan: { $eq: "premium" } });
  });

  test("empty fragments are skipped", () => {
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listValues: [] },
      { ...makeCondition("customAttribute"), attribute: "" },
    ];
    expect(conditionsToSift(conds)).toBeUndefined();
  });

  test("round-trip: $and of country + appVersion survives parse → emit", () => {
    const doc = {
      $and: [
        { country: { $in: ["TR"] } },
        { appVersion: { $gte: "1.2.3" } },
      ],
    };
    const parsed = siftToConditions(doc);
    expect(conditionsToSift(parsed)).toEqual(doc);
  });

  test("round-trip: single country list survives parse → emit", () => {
    const doc = { country: { $in: ["TR", "DE"] } };
    const parsed = siftToConditions(doc);
    expect(conditionsToSift(parsed)).toEqual(doc);
  });

  test("siftToConditions handles undefined", () => {
    expect(siftToConditions(undefined)).toEqual([]);
  });
});
