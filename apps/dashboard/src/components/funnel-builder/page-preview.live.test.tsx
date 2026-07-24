import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
import { evaluateNext, type AnswerMap } from "@rovenue/shared/funnel";
import { PagePreview, LEGAL_CHECKBOX_CHECKED } from "./page-preview";
import type { Page, Theme } from "./types";

// =============================================================
// PagePreview — live input capture
// =============================================================
//
// The rule these tests exist to protect: liveness is decided by `mode`,
// NOT by whether `onAnswer` was passed. Two cases below deliberately pass
// `onAnswer` while in "preview" mode — if either ever goes live, the
// builder canvas has become interactive and nobody would be watching.

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

function L(s: string) {
  return { en: s } as unknown as Page["title"];
}

const emailPage: Page = {
  id: "pg_email",
  type: "email",
  question_id: "q_email",
  title: L("Your email"),
};

const longTextPage: Page = {
  id: "pg_long",
  type: "long_text",
  question_id: "q_long",
  title: L("Tell us more"),
} as Page;

const singleChoicePage: Page = {
  id: "pg_single",
  type: "single_choice",
  question_id: "q_goal",
  title: L("Pick one"),
  options: [
    { label: L("Option A") as never, value: "opt_a" },
    { label: L("Option B") as never, value: "opt_b" },
  ],
};

const multiChoicePage: Page = {
  ...singleChoicePage,
  id: "pg_multi",
  type: "multi_choice",
};

const yesNoPage: Page = {
  id: "pg_yn",
  type: "yes_no",
  question_id: "q_yn",
  title: L("Are you sure?"),
};

const numberPage: Page = {
  id: "pg_num",
  type: "number_input",
  question_id: "q_num",
  title: L("How many?"),
  min: 0,
  max: 100,
  step: 1,
} as Page;

const sliderPage: Page = {
  id: "pg_slider",
  type: "slider",
  question_id: "q_slider",
  title: L("Pick a level"),
  min: 0,
  max: 100,
  step: 1,
} as Page;

const opinionPage: Page = {
  id: "pg_op",
  type: "opinion_scale",
  question_id: "q_op",
  title: L("Rate this"),
  min: 1,
  max: 5,
} as Page;

const ratingPage: Page = {
  id: "pg_rate",
  type: "rating",
  question_id: "q_rate",
  title: L("Rate your experience"),
  max: 5,
} as Page;

const picturePage: Page = {
  id: "pg_pic",
  type: "picture_choice",
  question_id: "q_pic",
  title: L("Pick the one that fits"),
  options: [
    { label: L("Option A") as never, value: "opt_a", imageUrl: "" },
    { label: L("Option B") as never, value: "opt_b", imageUrl: "" },
  ],
} as Page;

const legalPage: Page = {
  id: "pg_legal",
  type: "legal",
  question_id: "q_legal",
  title: L("Please review and accept"),
  agreementLabel: L("I agree to the terms"),
} as Page;

// `legal` and `checkbox` render the SAME LegalCheckbox component, so the
// legal tests already exercise the shared emit path. `checkbox` gets its
// own case anyway: without it, a `page.type`-branching regression inside
// LegalCheckbox that broke only `checkbox` would go uncaught.
const checkboxPage: Page = {
  id: "pg_checkbox",
  type: "checkbox",
  question_id: "q_checkbox",
  title: L("Acknowledge"),
  agreementLabel: L("I understand"),
} as Page;

const phonePage: Page = {
  id: "pg_phone",
  type: "phone",
  question_id: "q_phone",
  title: L("Your number"),
} as Page;

const datePage: Page = {
  id: "pg_date",
  type: "date_input",
  question_id: "q_date",
  title: L("Pick a date"),
} as Page;

function base(page: Page) {
  return {
    page,
    theme: THEME,
    pages: [page],
    locale: "en" as const,
    defaultLocale: "en" as const,
  };
}

describe("PagePreview — live mode", () => {
  it("captures a text answer", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview {...base(emailPage)} mode="live" value={null} onAnswer={onAnswer} />,
    );
    await userEvent.type(screen.getByRole("textbox"), "a");
    expect(onAnswer).toHaveBeenLastCalledWith("a");
  });

  it("long_text captures the typed string", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(longTextPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.type(screen.getByRole("textbox"), "a");
    expect(onAnswer).toHaveBeenLastCalledWith("a");
  });

  it("captures a single choice as the option's value", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(singleChoicePage)}
        mode="live"
        value={null}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).toHaveBeenLastCalledWith("opt_b");
  });

  it("accumulates multi-choice selections", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(multiChoicePage)}
        mode="live"
        value={["opt_a"]}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).toHaveBeenLastCalledWith(["opt_a", "opt_b"]);
  });

  it("removes a multi-choice selection on re-click, keeping the order of the rest", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(multiChoicePage)}
        mode="live"
        value={["opt_a", "opt_b"]}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByText("Option A"));
    expect(onAnswer).toHaveBeenLastCalledWith(["opt_b"]);
  });

  it("captures yes/no as the option's VALUE STRING, so a rule operand can match it", async () => {
    // Not a boolean. rule-editor.tsx writes a clause operand from a
    // free-text input, so it is always a string, and evalClause's `eq` is
    // strict equality — a boolean answer could never match a rule an
    // author is able to write.
    const onAnswer = vi.fn();
    render(
      <PagePreview {...base(yesNoPage)} mode="live" value={null} onAnswer={onAnswer} />,
    );
    await userEvent.click(screen.getByText("Yes"));
    expect(onAnswer).toHaveBeenLastCalledWith("yes");
  });

  it("number_input emits a real number, not a string, on increment", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(numberPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByLabelText("increment"));
    expect(onAnswer).toHaveBeenLastCalledWith(1);
    expect(typeof onAnswer.mock.lastCall![0]).toBe("number");
  });

  it("number_input records nothing until the visitor interacts (resting position is not an answer)", () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(numberPage)} mode="live" value={null} onAnswer={onAnswer} />);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("slider emits a number on change and nothing at rest", async () => {
    const onAnswer = vi.fn();
    const { container } = render(
      <PagePreview {...base(sliderPage)} mode="live" value={null} onAnswer={onAnswer} />,
    );
    expect(onAnswer).not.toHaveBeenCalled(); // resting midpoint is not an answer
    const range = container.querySelector('input[type="range"]')!;
    await userEvent.click(range); // ensure it is interactable
    // jsdom + user-event cannot drag a slider, so drive it directly. A
    // plain `range.value = "42"` is silently swallowed: React 19 attaches a
    // value-tracker to the DOM node so a same-value re-set is invisible to
    // its change detection, and assigning `.value` through the ordinary
    // setter updates that tracker too, so the follow-up `input` event never
    // reaches React's onChange. Going through the underlying native
    // HTMLInputElement setter (the same trick @testing-library/react's
    // fireEvent uses internally) bypasses the tracker so the event fires.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    nativeSetter.call(range, "42");
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onAnswer).toHaveBeenLastCalledWith(42);
  });

  it("opinion_scale emits the picked cell as a number", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(opinionPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onAnswer).toHaveBeenLastCalledWith(3);
  });

  it("rating emits the picked star count as a number", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(ratingPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByLabelText("rate 4"));
    expect(onAnswer).toHaveBeenLastCalledWith(4);
  });

  it("picture_choice emits the clicked option's value", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(picturePage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).toHaveBeenLastCalledWith("opt_b");
  });

  it("legal emits the checked constant when checked", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(legalPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onAnswer).toHaveBeenLastCalledWith(LEGAL_CHECKBOX_CHECKED);
  });

  it("legal returns to unanswered when unchecked", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(legalPage)}
        mode="live"
        value={LEGAL_CHECKBOX_CHECKED}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox")); // uncheck
    expect(onAnswer).toHaveBeenLastCalledWith("");
  });

  it("checkbox emits the checked constant when checked", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(checkboxPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onAnswer).toHaveBeenLastCalledWith(LEGAL_CHECKBOX_CHECKED);
  });

  it("phone captures the typed string", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(phonePage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.type(screen.getByRole("textbox"), "5");
    expect(onAnswer).toHaveBeenLastCalledWith("5");
  });

  it("date_input captures an ISO-8601 string", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(datePage)} mode="live" value={null} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText("date"), { target: { value: "2026-07-25" } });
    expect(onAnswer).toHaveBeenLastCalledWith("2026-07-25");
  });
});

describe("PagePreview — preview mode stays inert", () => {
  it("keeps text inputs read-only even when onAnswer is passed", () => {
    const onAnswer = vi.fn();
    // onAnswer is passed DELIBERATELY. `mode`, not the callback's
    // presence, is what decides — see the Props comment.
    render(<PagePreview {...base(emailPage)} mode="preview" onAnswer={onAnswer} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });

  it("DEFAULTS to preview when mode is omitted entirely", async () => {
    // Every other preview assertion passes mode="preview" explicitly, so
    // flipping the default would red nothing — and that mutation makes the
    // builder canvas interactive, which is the whole thing `mode` exists to
    // prevent. The builder call sites pass no `mode` at all, so this is the
    // shape they actually get.
    const onAnswer = vi.fn();
    render(<PagePreview {...base(singleChoicePage)} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not fire onAnswer from a choice click even when onAnswer is passed", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview {...base(singleChoicePage)} mode="preview" onAnswer={onAnswer} />,
    );
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

// =============================================================
// Round trip: does a captured answer actually match a rule an author
// can write?
// =============================================================
//
// The seam neither per-type test can see. Task 2 proved "yes_no captures
// X" and Task 3 proved "X is sent"; nobody checked what the OTHER side of
// the comparison holds. rule-editor.tsx writes a clause operand from a
// free-text input, so it is always a string, and evalClause's `eq` is
// strict equality — a boolean answer could never match. These tests feed
// the captured value straight into the real evaluator.

describe("captured answers match author-written rules", () => {
  function routes(questionId: string, captured: unknown, operand: string) {
    const answers: AnswerMap = new Map([[questionId, captured as never]]);
    return evaluateNext({
      page: {
        id: "pg_1",
        type: "question",
        next_rules: [
          {
            id: "rule_1",
            condition: {
              op: "all",
              clauses: [{ question_id: questionId, op: "eq", value: operand }],
            },
            goto: "pg_match",
          },
        ],
        default_next: "pg_default",
      },
      pagesOrder: ["pg_1", "pg_match", "pg_default"],
      answers,
      pagesById: new Map([
        ["pg_1", { id: "pg_1", type: "question" }],
        ["pg_match", { id: "pg_match", type: "info" }],
        ["pg_default", { id: "pg_default", type: "info" }],
      ]),
    });
  }

  it("a yes/no answer matches a rule whose operand is the option value", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview {...base(yesNoPage)} mode="live" value={null} onAnswer={onAnswer} />,
    );
    await userEvent.click(screen.getByText("Yes"));
    const captured = onAnswer.mock.calls.at(-1)![0];

    expect(routes("q_yn", captured, "yes")).toEqual({
      next: "page",
      pageId: "pg_match",
    });
  });

  it("a single-choice answer matches a rule whose operand is the option value", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(singleChoicePage)}
        mode="live"
        value={null}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.click(screen.getByText("Option B"));
    const captured = onAnswer.mock.calls.at(-1)![0];

    expect(routes("q_goal", captured, "opt_b")).toEqual({
      next: "page",
      pageId: "pg_match",
    });
  });
});
