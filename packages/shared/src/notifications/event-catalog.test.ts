import { describe, it, expect } from "vitest";
import { EVENT_CATALOG, getEvent, listEventKeysByCategory } from "./event-catalog";

describe("event catalog", () => {
  it("has exactly 16 events in v1", () => {
    expect(Object.keys(EVENT_CATALOG)).toHaveLength(16);
  });

  it("every event's forcedChannels is a subset of defaultChannels", () => {
    for (const e of Object.values(EVENT_CATALOG)) {
      for (const ch of e.forcedChannels) {
        expect(e.defaultChannels).toContain(ch);
      }
    }
  });

  it("digest events disallow push", () => {
    expect(EVENT_CATALOG["revenue.digest.daily"]!.pushAllowed).toBe(false);
    expect(EVENT_CATALOG["revenue.digest.weekly"]!.pushAllowed).toBe(false);
  });

  it("getEvent throws on unknown key", () => {
    expect(() => getEvent("nope")).toThrow(/unknown event/i);
  });

  it("listEventKeysByCategory groups correctly", () => {
    expect(listEventKeysByCategory("team")).toEqual(
      expect.arrayContaining([
        "team.member.invited",
        "team.member.role_changed",
        "team.member.removed",
      ]),
    );
    expect(listEventKeysByCategory("security")).toHaveLength(2);
  });
});
