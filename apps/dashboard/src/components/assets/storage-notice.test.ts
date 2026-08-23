import { describe, expect, it } from "vitest";
import {
  ASSET_STORAGE_CRITICAL_RATIO,
  ASSET_STORAGE_WARN_RATIO,
} from "@rovenue/shared";
import { noticeSeverity, storageNoticeFor } from "./storage-notice";

const LIMIT = 1000;
const at = (ratio: number) => ({ usedBytes: LIMIT * ratio, limitBytes: LIMIT });

describe("storageNoticeFor", () => {
  it("says nothing while there is room", () => {
    expect(storageNoticeFor(at(0))).toBe("none");
    expect(storageNoticeFor(at(ASSET_STORAGE_WARN_RATIO - 0.01))).toBe("none");
  });

  it("warns from the warn ratio, and escalates at the critical one", () => {
    expect(storageNoticeFor(at(ASSET_STORAGE_WARN_RATIO))).toBe("warning");
    expect(storageNoticeFor(at(ASSET_STORAGE_CRITICAL_RATIO - 0.01))).toBe("warning");
    expect(storageNoticeFor(at(ASSET_STORAGE_CRITICAL_RATIO))).toBe("critical");
  });

  it("calls a project sitting exactly on its cap full", () => {
    // The server refuses anything that would take the total past the
    // cap, so at 100% nothing more fits — "critical" would be a lie.
    expect(storageNoticeFor(at(1))).toBe("full");
    expect(storageNoticeFor({ usedBytes: LIMIT + 1, limitBytes: LIMIT })).toBe("full");
    expect(storageNoticeFor({ usedBytes: 0, limitBytes: 0 })).toBe("full");
  });

  it("has nothing to say about an unlimited or unloaded project", () => {
    expect(storageNoticeFor({ usedBytes: 10 ** 9, limitBytes: null })).toBe("none");
    expect(storageNoticeFor(undefined)).toBe("none");
  });
});

describe("noticeSeverity", () => {
  it("reserves the blocked severity for the one state that stops an upload", () => {
    // Colour is keyed off this, and the colour has to answer "does the
    // upload button still work?" — not "how alarming is the number?".
    // At the critical ratio there is still real headroom, and a small
    // file uploads exactly as it did at the warn ratio, so the two share
    // a severity. What makes `critical` critical is its copy, which
    // names the room left; only `full` refuses bytes, and only `full`
    // gets the colour that says so.
    expect(noticeSeverity("none")).toBe("idle");
    expect(noticeSeverity("warning")).toBe("attention");
    expect(noticeSeverity("critical")).toBe("attention");
    expect(noticeSeverity("full")).toBe("blocked");
  });
});
