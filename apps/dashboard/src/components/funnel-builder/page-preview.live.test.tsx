import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
import { evaluateNext, type AnswerMap } from "@rovenue/shared/funnel";
import { PagePreview } from "./page-preview";
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
});

describe("PagePreview — preview mode stays inert", () => {
  it("keeps text inputs read-only even when onAnswer is passed", () => {
    const onAnswer = vi.fn();
    // onAnswer is passed DELIBERATELY. `mode`, not the callback's
    // presence, is what decides — see the Props comment.
    render(<PagePreview {...base(emailPage)} mode="preview" onAnswer={onAnswer} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
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
