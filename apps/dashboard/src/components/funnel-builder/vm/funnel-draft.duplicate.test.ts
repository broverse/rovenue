import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { FunnelDraftViewModel } from "./funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";

// A question_id is an ANSWER KEY: the public runner's answer map and the
// server's `funnel_answers` table both key on it. `pg_1` carries one
// (`q_a`) plus a rule branching on its own answer; `pg_2` carries a rule
// that branches on `pg_1`'s answer (a normal cross-page reference);
// `pg_info` is a plain info screen with no question at all.
function fakeFunnel(): FunnelDetailDto {
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
      { id: "pg_info", type: "info", title: "Hi" } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {
      pg_1: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: "q_a", op: "eq", value: "x" }] },
          goto: "pg_info",
        },
      ],
      pg_2: [
        {
          id: "r_2",
          condition: { op: "all", clauses: [{ question_id: "q_a", op: "eq", value: "x" }] },
          goto: "pg_info",
        },
      ],
      // An info page has no question of its own but can still branch on
      // an earlier one — the case that used to lose its rules entirely.
      pg_info: [
        {
          id: "r_3",
          condition: { op: "all", clauses: [{ question_id: "q_a", op: "eq", value: "x" }] },
          goto: "pg_2",
        },
      ],
    },
    draftDefaultNext: { pg_1: "pg_info" },
    draftDiffersFromPublished: false,
    defaultLocale: "en",
    locales: ["en"],
    updatedAt: "",
    createdAt: "",
  };
}

function makeVm() {
  const container = new Container(tsyringeContainer);
  container.register(FunnelApi, {
    useValue: {
      get: vi.fn().mockResolvedValue(fakeFunnel()),
      patchDraft: vi.fn(),
      publish: vi.fn(),
      duplicate: vi.fn(),
    } as unknown as FunnelApi,
  });
  return container.resolve(FunnelDraftViewModel, { projectId: "p_1", funnelId: "f_1" });
}

describe("FunnelDraftViewModel — duplicatePage answer-key isolation", () => {
  it("gives the copy its own question_id", async () => {
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_1");

    const [original, copy] = vm.pages;
    expect(copy!.question_id).toBeDefined();
    expect(copy!.question_id).not.toBe(original!.question_id);
    // The original is untouched — other pages' rules still point at it.
    expect(original!.question_id).toBe("q_a");
  });

  it("rewrites the copy's OWN rules to the new question_id", async () => {
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_1");

    const copy = vm.pages[1]!;
    // Rules live in the VM's `rules` map, keyed by page id — not embedded
    // on the Page itself (see funnel-draft.vm.ts `applyServer`).
    const copyRules = vm.rules[copy.id]!;
    const clause = copyRules[0]!.condition.clauses[0]!;
    expect(clause.question_id).toBe(copy.question_id);
    expect(clause.question_id).not.toBe("q_a");
  });

  it("leaves another page's rules pointing at the original", async () => {
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_1");

    const clause = vm.rules["pg_2"]![0]!.condition.clauses[0]!;
    expect(clause.question_id).toBe("q_a");
  });

  it("leaves a page with no question_id alone", async () => {
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_info");

    const copy = vm.pages[3]!;
    expect(copy.question_id).toBeUndefined();
  });

  it("keeps the rules of a page that has NO question of its own", async () => {
    // An info or paywall page carries no question_id but can still branch
    // on an earlier one. Gating the rule copy on the page having its own
    // question silently deleted that branch.
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_info");

    const copy = vm.pages[3]!;
    const copied = vm.rules[copy.id];
    expect(copied, "the copy lost its rules").toBeDefined();
    expect(copied![0]!.goto).toBe("pg_2");
    // Its clause still points at the earlier page's question — the copy
    // asks the same thing of the same answer.
    expect(copied![0]!.condition.clauses[0]!.question_id).toBe("q_a");
  });

  it("copies the explicit default_next too", async () => {
    // Half-copied branching is worse than none: without this the copy
    // falls through to the SEQUENTIAL next page while the original went
    // somewhere explicit.
    const vm = makeVm();
    await vm.load(() => {});

    vm.duplicatePage("pg_1");

    const copy = vm.pages[1]!;
    expect(vm.defaultNext[copy.id]).toBe("pg_info");
  });
});
