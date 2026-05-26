// =============================================================
// timezonesAtLocalHour — unit tests
// =============================================================

import { describe, expect, it } from "vitest";
import { timezonesAtLocalHour } from "./tz";

describe("timezonesAtLocalHour", () => {
  it("12:00Z → Asia/Tokyo (UTC+9) is NOT at 12 (it's 21)", () => {
    const utc = new Date("2026-05-26T12:00:00.000Z");
    const at12 = timezonesAtLocalHour(utc, 12);
    expect(at12).not.toContain("Asia/Tokyo");
  });

  it("12:00Z → London (UTC+1 in BST) is at 13, but 13 includes it", () => {
    // 2026-05-26 is summer time in London (UTC+1).
    const utc = new Date("2026-05-26T12:00:00.000Z");
    expect(timezonesAtLocalHour(utc, 13)).toContain("Europe/London");
    expect(timezonesAtLocalHour(utc, 12)).not.toContain("Europe/London");
  });

  it("06:00Z → Istanbul (UTC+3 year-round) is at 09", () => {
    const utc = new Date("2026-05-26T06:00:00.000Z");
    expect(timezonesAtLocalHour(utc, 9)).toContain("Europe/Istanbul");
  });

  it("18:00Z → Mexico_City (UTC-6 in CST) is at 12", () => {
    // 2026-01-15: standard time in Mexico City (UTC-6).
    // Mexico abolished DST nationally in 2022 (except border zone).
    const utc = new Date("2026-01-15T18:00:00.000Z");
    expect(timezonesAtLocalHour(utc, 12)).toContain("America/Mexico_City");
  });

  it("UTC zones are at 09 when given 09:00Z", () => {
    // `Intl.supportedValuesOf` returns canonical zone names, and
    // the canonical form of UTC varies by ICU build: some emit
    // "UTC", others "Etc/UTC", others fold it into Africa/Abidjan
    // (the IANA "Link" target). Assert against the first one
    // that's actually in the set so the test is build-stable.
    const utc = new Date("2026-05-26T09:00:00.000Z");
    const at9 = timezonesAtLocalHour(utc, 9);
    const utcLike = ["UTC", "Etc/UTC", "Africa/Abidjan"].find((z) =>
      at9.includes(z),
    );
    expect(utcLike).toBeDefined();
  });

  it("DST: US spring-forward shifts which zones land in a given hour", () => {
    // 2026-03-08 02:00 local = US spring-forward. Before the
    // jump, 13:00Z is 08:00 EST (UTC-5). After, 13:00Z is 09:00
    // EDT (UTC-4). So America/New_York should be at hour 8 on
    // 2026-03-07 and at hour 9 on 2026-03-08 — same UTC clock,
    // different local hour because DST shifted between those days.
    const beforeDst = new Date("2026-03-07T13:00:00.000Z");
    const afterDst = new Date("2026-03-08T13:00:00.000Z");

    expect(timezonesAtLocalHour(beforeDst, 8)).toContain("America/New_York");
    expect(timezonesAtLocalHour(beforeDst, 9)).not.toContain("America/New_York");

    expect(timezonesAtLocalHour(afterDst, 9)).toContain("America/New_York");
    expect(timezonesAtLocalHour(afterDst, 8)).not.toContain("America/New_York");
  });

  it("targetHour out of range throws", () => {
    expect(() => timezonesAtLocalHour(new Date(), -1)).toThrow(RangeError);
    expect(() => timezonesAtLocalHour(new Date(), 24)).toThrow(RangeError);
    expect(() => timezonesAtLocalHour(new Date(), 9.5)).toThrow(RangeError);
  });

  it("partitions the IANA set: every zone falls in exactly one bucket", () => {
    // For any single UTC instant, every supported zone reports
    // exactly one local hour, so summing |timezonesAtLocalHour(h)|
    // across h=0..23 equals the total zone count. This catches
    // ICU edge cases (e.g. "24" being emitted for midnight).
    const utc = new Date("2026-05-26T12:00:00.000Z");
    const total = (
      Intl as unknown as { supportedValuesOf: (k: "timeZone") => string[] }
    ).supportedValuesOf("timeZone").length;
    let sum = 0;
    for (let h = 0; h < 24; h++) {
      sum += timezonesAtLocalHour(utc, h).length;
    }
    expect(sum).toBe(total);
  });
});
