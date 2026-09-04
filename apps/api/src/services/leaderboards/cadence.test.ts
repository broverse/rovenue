import { describe, expect, test } from "vitest";
import {
  nextSeasonWindow,
  seasonWindowContaining,
  validateCadence,
} from "./cadence";
import type { LeaderboardCadence } from "@rovenue/db";

const ISTANBUL = "Europe/Istanbul";   // UTC+3, no DST since 2016
const BERLIN = "Europe/Berlin";       // UTC+1 / UTC+2, DST
const UTC = "UTC";
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");

describe("validateCadence", () => {
  test("CUSTOM requires a positive customPeriodDays", () => {
    expect(validateCadence("CUSTOM", null)).not.toBeNull();
    expect(validateCadence("CUSTOM", 0)).not.toBeNull();
    expect(validateCadence("CUSTOM", -3)).not.toBeNull();
    expect(validateCadence("CUSTOM", 14)).toBeNull();
  });

  test("non-CUSTOM rejects customPeriodDays", () => {
    expect(validateCadence("WEEKLY", 7)).not.toBeNull();
    expect(validateCadence("MONTHLY", 30)).not.toBeNull();
    expect(validateCadence("WEEKLY", null)).toBeNull();
    expect(validateCadence("MONTHLY", null)).toBeNull();
  });
});

describe("seasonWindowContaining — WEEKLY", () => {
  test("a Wednesday resolves to that week's Monday 00:00 local", () => {
    // 2026-09-02 is a Wednesday.
    const w = seasonWindowContaining(
      new Date("2026-09-02T12:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );

    // Monday 2026-08-31 00:00 in UTC+3 is 2026-08-30T21:00Z.
    expect(w.startsAt.toISOString()).toBe("2026-08-30T21:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-09-06T21:00:00.000Z");
  });

  test("Saturday evening local is inside the week, not cut off by UTC", () => {
    // 2026-09-05T22:00Z is Sunday 01:00 in Istanbul, still in the week
    // that began Monday 2026-08-31. A UTC-only boundary would have
    // already rolled over.
    const w = seasonWindowContaining(
      new Date("2026-09-05T22:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-08-30T21:00:00.000Z");
  });

  test("a DST transition does not shorten or lengthen the local week", () => {
    // Berlin leaves DST on 2026-10-25. The window must still start and
    // end at local Monday 00:00, so its UTC length is 169 hours, not 168.
    const w = seasonWindowContaining(
      new Date("2026-10-21T12:00:00.000Z"),
      "WEEKLY",
      BERLIN,
      null,
      ANCHOR,
    );
    const hours = (w.endsAt.getTime() - w.startsAt.getTime()) / 3_600_000;
    expect(hours).toBe(169);
  });
});

describe("seasonWindowContaining — MONTHLY", () => {
  test("mid-month resolves to the 1st at 00:00 local", () => {
    const w = seasonWindowContaining(
      new Date("2026-09-17T08:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a 31-day month rolls to the next 1st, not to day 31", () => {
    // Anchoring off a 31st is the classic month-arithmetic bug: naive
    // +1 month from Jan 31 lands on Mar 3.
    const w = seasonWindowContaining(
      new Date("2026-01-31T12:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      new Date("2026-01-31T00:00:00.000Z"),
    );
    expect(w.startsAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("seasonWindowContaining — CUSTOM", () => {
  test("counts whole periods from the anchor", () => {
    const w = seasonWindowContaining(
      new Date("2026-01-16T00:00:00.000Z"),
      "CUSTOM",
      UTC,
      14,
      ANCHOR,
    );
    expect(w.startsAt.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-01-29T00:00:00.000Z");
  });
});

describe("nextSeasonWindow", () => {
  test("starts exactly where the previous one ended, leaving no gap", () => {
    const first = seasonWindowContaining(
      new Date("2026-09-02T12:00:00.000Z"),
      "WEEKLY",
      ISTANBUL,
      null,
      ANCHOR,
    );
    const second = nextSeasonWindow(first, "WEEKLY", ISTANBUL, null, ANCHOR);

    // No event may fall between two seasons. This is what lets the
    // snapshot settle delay be safe: the next season already started.
    expect(second.startsAt.getTime()).toBe(first.endsAt.getTime());
    expect(second.endsAt.getTime()).toBeGreaterThan(second.startsAt.getTime());
  });

  test("chains across a month boundary without drift", () => {
    let w = seasonWindowContaining(
      new Date("2026-01-05T00:00:00.000Z"),
      "MONTHLY",
      UTC,
      null,
      ANCHOR,
    );
    for (let i = 0; i < 13; i += 1) {
      const next = nextSeasonWindow(w, "MONTHLY", UTC, null, ANCHOR);
      expect(next.startsAt.getTime()).toBe(w.endsAt.getTime());
      w = next;
    }
    // 13 steps on from January 2026 is February 2027.
    expect(w.startsAt.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });
});
