import { describe, expect, it } from "vitest";
import {
  ASSET_STORAGE_CRITICAL_RATIO,
  ASSET_STORAGE_WARN_RATIO,
} from "@rovenue/shared";
import { storageNoticeFor } from "./storage-notice";

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
