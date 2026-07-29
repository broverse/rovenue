import { describe, expect, it } from "vitest";
import {
  borderStyle,
  NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX,
  resolveButtonVisualStyle,
  resolveThemeColor,
  stackContainerStyle,
  textBadgeStyle,
  type ButtonBaseVisual,
} from "./styles";

// =============================================================
// Node style pass (border / background / labelColor / cornerRadius,
// 2026-07-29). Pure-helper unit tests — see nodes.tsx/renderer.test.tsx
// for the integration-level assertions (actual DOM output, override flow).
// =============================================================

describe("borderStyle", () => {
  it("returns undefined when border is absent", () => {
    expect(borderStyle(undefined, "light")).toBeUndefined();
  });

  it("renders the light color in the light scheme", () => {
    expect(borderStyle({ width: 2, color: { light: "#ff0000", dark: "#00ff00" } }, "light")).toBe(
      "2px solid #ff0000",
    );
  });

  it("renders the dark color in the dark scheme", () => {
    expect(borderStyle({ width: 2, color: { light: "#ff0000", dark: "#00ff00" } }, "dark")).toBe(
      "2px solid #00ff00",
    );
  });

  it("falls back to light when dark is absent, in the dark scheme", () => {
    expect(borderStyle({ width: 1, color: { light: "#123456" } }, "dark")).toBe("1px solid #123456");
  });
});

describe("textBadgeStyle", () => {
  it("resolves both backgroundColor and borderRadius when both are set", () => {
    expect(textBadgeStyle({ light: "#eeeeee", dark: "#333333" }, 6, "dark")).toEqual({
      backgroundColor: "#333333",
      borderRadius: "6px",
    });
  });

  it("resolves undefined for both when neither is set — today's output", () => {
    expect(textBadgeStyle(undefined, undefined, "light")).toEqual({
      backgroundColor: undefined,
      borderRadius: undefined,
    });
  });

  it("resolves background alone without requiring a cornerRadius", () => {
    expect(textBadgeStyle({ light: "#eeeeee" }, undefined, "light")).toEqual({
      backgroundColor: "#eeeeee",
      borderRadius: undefined,
    });
  });
});

describe("resolveButtonVisualStyle", () => {
  const base: ButtonBaseVisual = { background: "#111111", color: "#ffffff", border: "none" };

  it("is byte-identical to the base visual when no custom prop is set (regression pin)", () => {
    expect(resolveButtonVisualStyle(base, {}, NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX, "light")).toEqual({
      background: "#111111",
      color: "#ffffff",
      border: "none",
      borderRadius: "8px",
    });
  });

  it("lets a custom background override the base fill", () => {
    const result = resolveButtonVisualStyle(
      base,
      { background: { light: "#ff0000" } },
      NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX,
      "light",
    );
    expect(result.background).toBe("#ff0000");
    // Untouched fields stay exactly at the base's own value.
    expect(result.color).toBe(base.color);
    expect(result.border).toBe(base.border);
  });

  it("lets a custom labelColor override the base label color only", () => {
    const result = resolveButtonVisualStyle(
      base,
      { labelColor: { light: "#00ff00" } },
      NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX,
      "light",
    );
    expect(result.color).toBe("#00ff00");
    expect(result.background).toBe(base.background);
    expect(result.border).toBe(base.border);
  });

  it("lets a custom border override the base border only", () => {
    const result = resolveButtonVisualStyle(
      base,
      { border: { width: 2, color: { light: "#0000ff" } } },
      NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX,
      "light",
    );
    expect(result.border).toBe("2px solid #0000ff");
    expect(result.background).toBe(base.background);
    expect(result.color).toBe(base.color);
  });

  it("lets a custom cornerRadius override the default", () => {
    const result = resolveButtonVisualStyle(base, { cornerRadius: 20 }, NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX, "light");
    expect(result.borderRadius).toBe("20px");
  });

  it("resolves every custom prop through the active colorScheme, not just light", () => {
    const result = resolveButtonVisualStyle(
      base,
      {
        background: { light: "#ffffff", dark: "#000000" },
        labelColor: { light: "#111111", dark: "#eeeeee" },
        border: { width: 1, color: { light: "#aaaaaa", dark: "#555555" } },
      },
      NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX,
      "dark",
    );
    expect(result).toEqual({
      background: "#000000",
      color: "#eeeeee",
      border: "1px solid #555555",
      borderRadius: "8px",
    });
  });
});

describe("stackContainerStyle border", () => {
  it("draws no border when the node has none (regression pin)", () => {
    const style = stackContainerStyle({ axis: "v" }, "light");
    expect(style.border).toBeUndefined();
  });

  it("draws the resolved border when the node has one", () => {
    const style = stackContainerStyle(
      { axis: "v", border: { width: 3, color: { light: "#101010", dark: "#efefef" } } },
      "dark",
    );
    expect(style.border).toBe("3px solid #efefef");
  });
});

describe("resolveThemeColor (reused by borderStyle — sanity, not a re-test)", () => {
  it("resolves light vs dark independently of the border helper", () => {
    expect(resolveThemeColor({ light: "#111", dark: "#222" }, "light")).toBe("#111");
    expect(resolveThemeColor({ light: "#111", dark: "#222" }, "dark")).toBe("#222");
  });
});
