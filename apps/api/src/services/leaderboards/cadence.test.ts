import { describe, expect, test } from "vitest";
import {
  nextSeasonWindow,
  seasonWindowContaining,
  validateCadence,
} from "./cadence";
import type { SeasonWindow } from "./cadence";
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

  // Regression: elapsed-period counting must use local calendar days, not
  // a millisecond division against a fixed nominal period length. Once
  // the anchor (winter, UTC+1) and the instant sit on opposite sides of a
  // DST transition, a millisecond-based count is off by the DST delta —
  // and because that delta persists for months (not just on the
  // transition day), the bug turns `nextSeasonWindow` into a fixed point:
  // it returns the SAME window instead of the next one, for roughly half
  // of every year, in every DST-observing zone.
  test("customPeriodDays=1 keeps advancing across Berlin's spring-forward", () => {
    // Berlin leaves standard time for DST on 2026-03-29. Chain ten daily
    // CUSTOM periods starting a few days before the transition and
    // through it; a millisecond-based elapsed count gets stuck on one
    // side of 2026-03-29 and stops advancing.
    let w = seasonWindowContaining(
      new Date("2026-03-25T12:00:00.000Z"),
      "CUSTOM",
      BERLIN,
      1,
      ANCHOR,
    );
    for (let i = 0; i < 10; i += 1) {
      const next = nextSeasonWindow(w, "CUSTOM", BERLIN, 1, ANCHOR);
      expect(next.startsAt.getTime()).toBe(w.endsAt.getTime());
      // The fixed-point bug returns the SAME window (next.startsAt equal
      // to w.startsAt) instead of advancing — this assertion is what
      // catches it.
      expect(next.startsAt.getTime()).toBeGreaterThan(w.startsAt.getTime());
      w = next;
    }
  });

  test("customPeriodDays=7 resolves to the next window in Berlin summer, not the same one", () => {
    // ANCHOR (2026-01-01) is winter (UTC+1); mid-July is deep in DST
    // (UTC+2). Any instant on the DST side of the anchor exposes the bug,
    // not just instants exactly at the transition.
    const w = seasonWindowContaining(
      new Date("2026-07-15T12:00:00.000Z"),
      "CUSTOM",
      BERLIN,
      7,
      ANCHOR,
    );
    const next = seasonWindowContaining(w.endsAt, "CUSTOM", BERLIN, 7, ANCHOR);
    expect(next.startsAt.getTime()).toBe(w.endsAt.getTime());
    expect(next.endsAt.getTime()).toBeGreaterThan(next.startsAt.getTime());
  });
});

// Regression: some IANA zones spring forward exactly at local midnight,
// so that calendar day's 00:00 never occurs on the clock. All of the
// dates below were confirmed against the real IANA database by a
// reviewer; each is a Sunday, so WEEKLY (Monday) and MONTHLY (the 1st)
// never land on one — only a CUSTOM cadence can, and did, until this fix
// threw instead of producing a window. Policy: resolve forward to the
// first instant that DOES exist that local day (see cadence.ts).
describe("seasonWindowContaining — CUSTOM lands on a non-existent local midnight", () => {
  function localParts(date: Date, timeZone: string): Record<string, string> {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const by: Record<string, string> = {};
    for (const part of fmt.formatToParts(date)) {
      by[part.type] = part.value;
    }
    return by;
  }

  const cases: Array<{ zone: string; date: string }> = [
    { zone: "America/Santiago", date: "2026-09-06" },
    { zone: "America/Santiago", date: "2027-09-05" },
    { zone: "America/Santiago", date: "2028-09-03" },
    { zone: "America/Santiago", date: "2029-09-02" },
    { zone: "America/Havana", date: "2026-03-08" },
    { zone: "Asia/Beirut", date: "2027-03-28" },
    { zone: "Asia/Beirut", date: "2028-03-26" },
    { zone: "Asia/Beirut", date: "2029-03-25" },
  ];

  for (const { zone, date } of cases) {
    test(`${zone} ${date}: produces a window starting at the first existing local instant, not a throw`, () => {
      // A daily CUSTOM period anchored on the target date, with `instant`
      // on the same date, makes the elapsed-period count 0 — the window
      // start is exactly `toUtc(date, 0:00, zone)`, the boundary that
      // does not exist.
      const anchor = new Date(`${date}T12:00:00.000Z`);

      let window: SeasonWindow | undefined;
      expect(() => {
        window = seasonWindowContaining(anchor, "CUSTOM", zone, 1, anchor);
      }).not.toThrow();

      const w = window as unknown as SeasonWindow;
      const startParts = localParts(w.startsAt, zone);
      const [year, month, day] = date.split("-");

      // Lands on the requested calendar day...
      expect(startParts.year).toBe(year);
      expect(startParts.month).toBe(month);
      expect(startParts.day).toBe(day);
      // ...but not at local midnight, since that instant doesn't exist.
      expect(`${startParts.hour}:${startParts.minute}:${startParts.second}`).not.toBe(
        "00:00:00",
      );

      // One millisecond earlier must read the PREVIOUS calendar day —
      // proving this is the FIRST existing instant of the day, not just
      // some later instant that happens to also exist.
      const justBefore = localParts(new Date(w.startsAt.getTime() - 1), zone);
      const sameDay =
        justBefore.year === startParts.year &&
        justBefore.month === startParts.month &&
        justBefore.day === startParts.day;
      expect(sameDay).toBe(false);
    });
  }
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
