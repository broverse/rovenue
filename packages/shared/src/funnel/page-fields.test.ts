import { describe, expect, it } from "vitest";
import { validatePageFields } from "./page-fields";

describe("validatePageFields", () => {
  it("rejects a single_choice page with no options", () => {
    const result = validatePageFields([
      { id: "p1", type: "single_choice", title: "Pick one" },
    ] as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects a single_choice page whose options array is empty", () => {
    const result = validatePageFields([
      { id: "p1", type: "single_choice", title: "Pick one", options: [] },
    ] as never);
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed single_choice page", () => {
    const result = validatePageFields([
      {
        id: "p1",
        type: "single_choice",
        title: "Pick one",
        options: [{ label: "A", value: "a" }],
      },
    ] as never);
    expect(result.ok).toBe(true);
  });

  it("rejects a multi_choice page with no options and names the page and field", () => {
    // An agent gets this text back as its only feedback, so it has to say
    // which page and which field.
    const result = validatePageFields([
      { id: "p9", type: "multi_choice", title: "Pick some" },
    ] as never);
    if (result.ok) throw new Error("expected failure");
    expect(result.issues[0]?.message).toContain("p9");
    expect(result.issues[0]?.message).toMatch(/options/);
  });

  it("rejects a picture_choice page whose options array is empty", () => {
    const result = validatePageFields([
      { id: "p2", type: "picture_choice", title: "Pick one", options: [] },
    ] as never);
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed picture_choice page", () => {
    const result = validatePageFields([
      {
        id: "p2",
        type: "picture_choice",
        title: "Pick one",
        options: [{ label: "A", value: "a", imageUrl: "https://x/a.png" }],
      },
    ] as never);
    expect(result.ok).toBe(true);
  });

  // slider/opinion_scale/rating/number_input all fall back to real
  // min/max/step defaults in the renderer (page-preview.tsx), and
  // legal/checkbox/yes_no all fall back to default copy or a default
  // options pair — none of them are "unanswerable" without their
  // blank-page.ts defaults, only less customized. See page-fields.ts's
  // REQUIRED_FIELDS comment for the renderer evidence.
  it("accepts page types with a renderer fallback even when the field is absent", () => {
    const result = validatePageFields([
      { id: "s1", type: "slider", title: "How much?" },
      { id: "o1", type: "opinion_scale", title: "How do you feel?" },
      { id: "r1", type: "rating", title: "Rate us" },
      { id: "n1", type: "number_input", title: "How many?" },
      { id: "l1", type: "legal" },
      { id: "c1", type: "checkbox" },
      { id: "y1", type: "yes_no", title: "Sound good?" },
      { id: "i1", type: "info", title: "Heads up" },
    ] as never);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty pages array", () => {
    const result = validatePageFields([]);
    expect(result.ok).toBe(true);
  });
});
