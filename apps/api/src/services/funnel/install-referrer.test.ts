import { describe, expect, it } from "vitest";
import {
  buildInstallReferrer,
  parseInstallReferrer,
  REFERRER_KEY,
} from "./install-referrer";

describe("install referrer", () => {
  it("buildInstallReferrer encodes token under the canonical key", () => {
    expect(buildInstallReferrer("abc123")).toBe(`${REFERRER_KEY}%3Dabc123`);
  });

  it("parseInstallReferrer extracts token from a Google Play referrer string", () => {
    const referrer = "utm_source=funnel&rovenue_funnel_token=abc123&utm_medium=web";
    expect(parseInstallReferrer(referrer)).toBe("abc123");
  });

  it("parseInstallReferrer returns null when the key is absent", () => {
    expect(parseInstallReferrer("utm_source=test")).toBeNull();
  });

  it("parseInstallReferrer URL-decodes the value", () => {
    expect(parseInstallReferrer("rovenue_funnel_token=abc%2F123")).toBe("abc/123");
  });

  it("parseInstallReferrer is null on empty/whitespace input", () => {
    expect(parseInstallReferrer("")).toBeNull();
    expect(parseInstallReferrer("   ")).toBeNull();
  });
});
