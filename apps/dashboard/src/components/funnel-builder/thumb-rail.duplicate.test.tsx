import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceProvider, useService } from "impair";
import "../../i18n/config";
import { ThumbRail } from "./thumb-rail";
import { FunnelApi, type FunnelDetailDto } from "../../lib/services/funnel-api";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

// =============================================================
// ThumbRail — the duplicate-page action
// =============================================================
//
// `duplicatePage` was correct, tested and mutation-checked, and
// unreachable: nothing in the repo called it. These tests exist to pin
// REACHABILITY, so they drive the real view model rather than a spy —
// a spy would prove a button calls a function, not that duplicating a
// page actually duplicates it.
//
// Two things the markup can get wrong are pinned explicitly:
//   1. the row is itself a <button>, so the action must be a SIBLING;
//      a nested button is invalid HTML and swallows the click target.
//   2. without stopPropagation the click also reaches the row beneath,
//      so the visitor silently navigates while duplicating.

function dto(): FunnelDetailDto {
  return {
    id: "f_1",
    projectId: "p_1",
    slug: "s",
    name: "Test funnel",
    status: "draft",
    currentVersionId: null,
    currentVersionNo: null,
    draftPages: [
      { id: "pg_1", type: "single_choice", question_id: "q_a", options: [] } as never,
      { id: "pg_2", type: "single_choice", question_id: "q_b", options: [] } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {},
    draftDefaultNext: {},
    draftDiffersFromPublished: false,
    defaultLocale: "en",
    locales: ["en"],
    updatedAt: "",
    createdAt: "",
  };
}

/** Renders the rail inside real DI and hands back the live view model. */
async function renderRail() {
  let vm!: FunnelDraftViewModel;
  function Probe() {
    vm = useService(FunnelDraftViewModel);
    return null;
  }

  render(
    <ServiceProvider
      provide={[FunnelApi, FunnelDraftViewModel]}
      props={{ projectId: "p_1", funnelId: "f_1" }}
    >
      <Probe />
      <ThumbRail />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });
  return vm;
}

beforeEach(() => {
  vi.spyOn(FunnelApi.prototype, "get").mockResolvedValue(dto());
});

describe("ThumbRail — duplicate action", () => {
  it("offers a duplicate action for every page", async () => {
    await renderRail();
    expect(screen.getAllByRole("button", { name: /duplicate/i })).toHaveLength(2);
  });

  it("duplicates the page whose action was clicked", async () => {
    const vm = await renderRail();
    expect(vm.pages).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: /duplicate/i })[1]!);

    expect(vm.pages, "the page was not duplicated").toHaveLength(3);

    // Pin WHICH page was copied, not merely that the count grew. Asserting
    // only "some new page exists" passes just as happily when the button
    // duplicates the wrong row — the copy lands directly after its source,
    // so the order itself carries the evidence.
    const [first, source, copy] = vm.pages;
    expect(first!.id).toBe("pg_1");
    expect(source!.id, "the wrong page was duplicated").toBe("pg_2");
    expect(copy!.id).toMatch(/^pg_2_copy_/);

    // An answer key is per-page: sharing one would make the copy arrive
    // pre-filled with the original's answer.
    expect(copy!.question_id).toBeDefined();
    expect(copy!.question_id).not.toBe(source!.question_id);
  });

  it("does not also select the row underneath when duplicating", async () => {
    const vm = await renderRail();
    expect(vm.selectedPageId).toBe("pg_1");

    await userEvent.click(screen.getAllByRole("button", { name: /duplicate/i })[1]!);

    // duplicatePage deliberately selects the new copy. If the click also
    // bubbled into the row beneath, the row's `selectPage("pg_2")` would
    // run AFTERWARDS and overwrite that with the source page — so landing
    // on the copy is what proves the propagation was stopped.
    const copy = vm.pages[2]!;
    expect(vm.selectedPageId, "the duplicate click leaked into the row's select").toBe(copy.id);
    expect(vm.selectedPageId).not.toBe("pg_2");
  });
});
