import { describe, it, expect } from "vitest";
import {
  ListFeedQuery,
  ProjectNotificationDefaultsBody,
  RegisterPushDeviceBody,
  UnsubscribeBody,
  UpdatePreferencesBody,
} from "./api-schemas";

describe("UpdatePreferencesBody", () => {
  it("accepts a global-scope payload", () => {
    const parsed = UpdatePreferencesBody.parse({
      scope: "global",
      channels: { email: true, push: false },
      locale: "en",
      timezone: "Europe/Istanbul",
    });
    expect(parsed.scope).toBe("global");
  });

  it("accepts a project-scope payload with overrides", () => {
    const parsed = UpdatePreferencesBody.parse({
      scope: "project",
      projectId: "proj_abc123",
      overrides: { "revenue.anomaly.detected": false },
    });
    expect(parsed.scope === "project" && parsed.projectId).toBe("proj_abc123");
  });

  it("rejects an unknown scope", () => {
    expect(() =>
      UpdatePreferencesBody.parse({ scope: "nope" } as unknown),
    ).toThrow();
  });

  it("rejects a project payload without projectId", () => {
    expect(() =>
      UpdatePreferencesBody.parse({
        scope: "project",
        overrides: {},
      } as unknown),
    ).toThrow();
  });
});

describe("RegisterPushDeviceBody", () => {
  it("parses a valid iOS device registration", () => {
    const parsed = RegisterPushDeviceBody.parse({
      platform: "ios",
      token: "abc123",
      appBundleId: "com.example.app",
      locale: "en",
      timezone: "Europe/Istanbul",
    });
    expect(parsed.platform).toBe("ios");
  });

  it("rejects an unknown platform", () => {
    expect(() =>
      RegisterPushDeviceBody.parse({
        platform: "web",
        token: "x",
        appBundleId: "y",
        locale: "en",
        timezone: "UTC",
      } as unknown),
    ).toThrow();
  });

  it("rejects an oversized token", () => {
    expect(() =>
      RegisterPushDeviceBody.parse({
        platform: "android",
        token: "x".repeat(4097),
        appBundleId: "y",
        locale: "en",
        timezone: "UTC",
      }),
    ).toThrow();
  });
});

describe("UnsubscribeBody", () => {
  it("accepts a token of 20+ chars", () => {
    expect(
      UnsubscribeBody.parse({ token: "a".repeat(40) }).token.length,
    ).toBeGreaterThanOrEqual(20);
  });

  it("rejects short tokens", () => {
    expect(() => UnsubscribeBody.parse({ token: "short" })).toThrow();
  });
});

describe("ProjectNotificationDefaultsBody", () => {
  it("accepts an empty defaults map", () => {
    expect(
      ProjectNotificationDefaultsBody.parse({ defaults: {} }).defaults,
    ).toEqual({});
  });

  it("rejects non-boolean values", () => {
    expect(() =>
      ProjectNotificationDefaultsBody.parse({
        defaults: { "revenue.anomaly.detected": "yes" },
      } as unknown),
    ).toThrow();
  });
});

describe("ListFeedQuery", () => {
  it("coerces string limit to a number and applies the default", () => {
    expect(ListFeedQuery.parse({}).limit).toBe(20);
    expect(ListFeedQuery.parse({ limit: "10" }).limit).toBe(10);
  });

  it("coerces 'true' to a boolean for unread", () => {
    expect(ListFeedQuery.parse({ unread: "true" }).unread).toBe(true);
  });

  it("rejects limit > 50", () => {
    expect(() => ListFeedQuery.parse({ limit: "100" })).toThrow();
  });
});
