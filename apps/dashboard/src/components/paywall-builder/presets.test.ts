import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets";

describe("PRESETS", () => {
  it("every preset carries the metadata the start gallery renders", () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.tag).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(typeof preset.build).toBe("function");
    }
  });

  it("ids are unique", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset builds a config whose root has children", () => {
    for (const preset of PRESETS) {
      expect(preset.build("en").root.children.length).toBeGreaterThan(0);
    }
  });
});
