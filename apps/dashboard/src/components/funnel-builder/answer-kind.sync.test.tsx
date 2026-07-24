import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
import { PagePreview } from "./page-preview";
import { OPERATORS_BY_KIND, PAGE_TYPES, type AnswerKind } from "./types";
import type { Page, PageType, Theme } from "./types";

// =============================================================
// answerKind vs what the components actually emit
// =============================================================
//
// The evaluator dispatches on the RUNTIME value's type; the rule editor
// dispatches on the PAGE type via `answerKind`. Two answers to "what kind
// of answer is this". If they drift, the editor offers an operator the
// evaluator can never fire — the writable-but-dead rule this sub-project
// exists to remove, arriving from the other side.
//
// An earlier version of this test read `PAGE_TYPES[x].answerKind` and
// asserted something derived from `PAGE_TYPES[x].answerKind`, so it was
// one bit wide: reclassifying `email` as `number` left it green. This one
// RENDERS each wired page, drives a real interaction, and checks the value
// the component hands back — so a drift in either direction reds it.

const THEME: Theme = {
  primary: "#5B5BD6",
  bg: "#ffffff",
  text: "#111111",
  radius: 8,
  font: "",
  progressActive: "",
  progressInactive: "",
  backIcon: "chevron",
} as Theme;

const L = (v: string) => ({ en: v }) as unknown as Page["title"];

const OPTIONS = [
  { label: L("Option A") as never, value: "opt_a" },
  { label: L("Option B") as never, value: "opt_b" },
];

/**
 * Every page type the runner captures an answer for today (SP4 wired
 * six). Each entry says how to drive it and what shape it must hand back.
 *
 * A page type with a comparable answer (`answerKind !== "none"`) must be
 * accounted for in either this table or NOT_WIRED_YET below — the
 * coverage assertion at the bottom checks that partition, not just this
 * one.
 */
const WIRED: ReadonlyArray<{
  type: PageType;
  drive: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  options?: typeof OPTIONS;
}> = [
  { type: "email", drive: (u) => u.type(screen.getByRole("textbox"), "a") },
  { type: "short_text", drive: (u) => u.type(screen.getByRole("textbox"), "a") },
  { type: "text_input", drive: (u) => u.type(screen.getByRole("textbox"), "a") },
  { type: "single_choice", drive: (u) => u.click(screen.getByText("Option B")), options: OPTIONS },
  { type: "multi_choice", drive: (u) => u.click(screen.getByText("Option B")), options: OPTIONS },
  { type: "yes_no", drive: (u) => u.click(screen.getByText("Yes")) },
  { type: "number_input", drive: (u) => u.click(screen.getByLabelText("increment")) },
  {
    type: "slider",
    drive: async () => {
      fireEvent.change(screen.getByRole("slider"), { target: { value: "42" } });
    },
  },
  { type: "opinion_scale", drive: (u) => u.click(screen.getByRole("button", { name: "3" })) },
  { type: "rating", drive: (u) => u.click(screen.getByLabelText("rate 4")) },
  { type: "picture_choice", drive: (u) => u.click(screen.getByText("Option B")), options: OPTIONS },
  { type: "legal", drive: (u) => u.click(screen.getByRole("checkbox")) },
  { type: "checkbox", drive: (u) => u.click(screen.getByRole("checkbox")) },
  { type: "long_text", drive: (u) => u.type(screen.getByRole("textbox"), "a") },
  { type: "phone", drive: (u) => u.type(screen.getByRole("textbox"), "5") },
  {
    type: "date_input",
    drive: async () => {
      fireEvent.change(screen.getByLabelText("date"), { target: { value: "2026-07-25" } });
    },
  },
];

/**
 * Page types with a comparable answer (`answerKind !== "none"`) that the
 * runner does not capture yet. An explicit allow-list rather than "not in
 * WIRED" so a NEW page type added to PAGE_TYPES with a non-none
 * answerKind — the case this test exists to catch — fails the coverage
 * assertion below instead of silently being absorbed into "not wired".
 * Wiring one of these means moving it here out and into WIRED with a
 * `drive` function.
 */
const NOT_WIRED_YET: ReadonlySet<PageType> = new Set([]);

describe("answerKind agrees with what the wired inputs actually emit", () => {
  it.each(WIRED.map((w) => [w.type, w] as const))(
    "%s emits a value whose shape matches its answerKind",
    async (_type, wired) => {
      const onAnswer = vi.fn();
      const page: Page = {
        id: `pg_${wired.type}`,
        type: wired.type,
        question_id: "q_1",
        title: L("Question"),
        ...(wired.options ? { options: wired.options } : {}),
      };

      render(
        <PagePreview
          page={page}
          theme={THEME}
          pages={[page]}
          locale="en"
          defaultLocale="en"
          mode="live"
          value={null}
          onAnswer={onAnswer}
        />,
      );

      await wired.drive(userEvent.setup());

      expect(onAnswer, `${wired.type} emitted nothing`).toHaveBeenCalled();
      const emitted = onAnswer.mock.lastCall![0] as unknown;
      const kind: AnswerKind = PAGE_TYPES[wired.type].answerKind;

      // The contract: `multi` and only `multi` hands back an array, and a
      // `number` kind must hand back a number. Anything else is a string.
      if (kind === "multi") {
        expect(Array.isArray(emitted), `${wired.type} is multi but emitted a scalar`).toBe(true);
      } else if (kind === "number") {
        expect(typeof emitted, `${wired.type} is number but emitted otherwise`).toBe("number");
      } else {
        expect(Array.isArray(emitted), `${wired.type} is ${kind} but emitted an array`).toBe(false);
        expect(typeof emitted, `${wired.type} is ${kind} but emitted a non-string`).toBe("string");
      }
    },
  );

  it("every page type with a comparable answer is accounted for in WIRED or NOT_WIRED_YET", () => {
    // Every branchable page type (answerKind !== "none") must show up in
    // one of the two lists above. A type in neither is the gap this test
    // exists to make visible: a new page type added to PAGE_TYPES with a
    // real answerKind but forgotten here would otherwise offer working
    // operators (or claim not to) against nothing this test checked.
    const branchableTypes = (Object.keys(PAGE_TYPES) as PageType[]).filter(
      (t) => PAGE_TYPES[t].answerKind !== "none",
    );
    const wiredTypes = new Set(WIRED.map((w) => w.type));
    for (const t of branchableTypes) {
      const accountedFor = wiredTypes.has(t) || NOT_WIRED_YET.has(t);
      expect(
        accountedFor,
        `${t} is answerKind "${PAGE_TYPES[t].answerKind}" but is in neither WIRED nor NOT_WIRED_YET`,
      ).toBe(true);
    }
  });

  it("WIRED and NOT_WIRED_YET do not overlap", () => {
    const wiredTypes = new Set(WIRED.map((w) => w.type));
    for (const t of NOT_WIRED_YET) {
      expect(wiredTypes.has(t), `${t} is in both WIRED and NOT_WIRED_YET`).toBe(false);
    }
  });

  it("text and choice offer the same operators — the per-type check above cannot tell them apart", () => {
    // The per-type assertion (above, in the `else` branch) collapses
    // `text` and `choice` into "a string, not an array". That is only a
    // safe simplification while the two answer kinds' operator lists are
    // identical; the day they diverge, this is the assertion that has to
    // red for the seam to still mean anything.
    expect(OPERATORS_BY_KIND.text).toEqual(OPERATORS_BY_KIND.choice);
  });
});
