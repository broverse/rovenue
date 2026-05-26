import { describe, it, expect } from "vitest";
import { resolvePrefs } from "./resolve-prefs";

const userChannels = (
  overrides: Partial<{ email: boolean; push: boolean }> = {},
) => ({
  email: true,
  push: true,
  ...overrides,
});

describe("resolvePrefs", () => {
  it("returns code default when no project/user override", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toEqual(["email", "push", "inapp"]);
  });

  it("project default overrides code default", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: { "revenue.anomaly.detected": false },
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(false);
    expect(r.enabledChannels).toEqual([]);
  });

  it("user override beats project default", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: { "revenue.anomaly.detected": false },
      userOverrides: { "revenue.anomaly.detected": true },
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true);
  });

  it("forced event ignores user opt-out", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: { "security.signin.new_device": false },
      eventKey: "security.signin.new_device",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toContain("email");
  });

  it("channel-off filters channels not in forced list", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels({ push: false }),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toEqual(["email", "inapp"]);
  });

  it("channel-off cannot suppress forced channel", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels({ email: false }),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "security.signin.new_device",
    });
    expect(r.enabledChannels).toContain("email");
  });

  it("event disabled by user → no channels (forced empty case)", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: { "revenue.milestone.hit": false },
      eventKey: "revenue.milestone.hit",
    });
    expect(r.enabled).toBe(false);
    expect(r.enabledChannels).toEqual([]);
  });

  it("digest event drops push even if user has push on", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.digest.daily",
    });
    expect(r.enabledChannels).not.toContain("push");
    expect(r.enabledChannels).toEqual(["email", "inapp"]);
  });

  it("unknown event key throws", async () => {
    await expect(
      resolvePrefs({
        userChannels: userChannels(),
        projectDefaults: {},
        userOverrides: {},
        eventKey: "nope",
      }),
    ).rejects.toThrow(/unknown event/i);
  });

  it("inapp stays on when enabled even if email+push are off", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels({ email: false, push: false }),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.anomaly.detected",
    });
    expect(r.enabledChannels).toEqual(["inapp"]);
  });

  it("default-disabled event stays off without project re-enable", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: {},
      userOverrides: {},
      eventKey: "revenue.milestone.hit",
    });
    expect(r.enabled).toBe(false);
    expect(r.enabledChannels).toEqual([]);
  });

  it("default-disabled event can be enabled via project default", async () => {
    const r = await resolvePrefs({
      userChannels: userChannels(),
      projectDefaults: { "revenue.milestone.hit": true },
      userOverrides: {},
      eventKey: "revenue.milestone.hit",
    });
    expect(r.enabled).toBe(true);
    expect(r.enabledChannels).toContain("email");
  });
});
