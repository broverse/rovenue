import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
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

  it("captures yes/no as a boolean, not the option string", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview {...base(yesNoPage)} mode="live" value={null} onAnswer={onAnswer} />,
    );
    await userEvent.click(screen.getByText("Yes"));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
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
