import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
import { PagePreview } from "./page-preview";
import { PAGE_TYPES, type AnswerKind } from "./types";
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
 * A page type wired later and not added here is the gap this test exists
 * to make visible — see the coverage assertion at the bottom.
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
];

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

  it("no page type classified `multi` is missing from the wired table", () => {
    // `multi` is the kind whose operators (contains / not_contains) are
    // the ONLY ones that fire for an array. A multi page the runner does
    // not capture would offer working operators against nothing.
    const multiTypes = (Object.keys(PAGE_TYPES) as PageType[]).filter(
      (t) => PAGE_TYPES[t].answerKind === "multi",
    );
    const wiredTypes = new Set(WIRED.map((w) => w.type));
    for (const t of multiTypes) {
      expect(wiredTypes.has(t), `${t} is answerKind "multi" but is not wired`).toBe(true);
    }
  });
});
