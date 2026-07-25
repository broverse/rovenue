import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Container, ServiceProvider } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { RuleEditor } from "./rule-editor";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../lib/services/funnel-api";

// =============================================================
// Gap 1 (SP5 stale-clause fix): a clause authored before c65a761d can
// still point at a question whose answerKind is "none" (e.g.
// stored JSON). branchableQuestionIds excludes that question from
// the picker, so on render the question <select> would carry a stored
// `value` with no matching <option>, and the operator <select> would
// resolve to zero <option>s (OPERATORS_BY_KIND.none === []). That is
// the "displayed diverges from saved" state SP5 exists to remove.
// =============================================================

const STALE_QUESTION_ID = "q_contact";
const BRANCHABLE_QUESTION_ID = "q_choice";
const BRANCH_PAGE_ID = "pg_branch";
const STALE_CLAUSE_VALUE = "someone@example.com";

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
      {
        id: "pg_choice",
        type: "single_choice",
        question_id: BRANCHABLE_QUESTION_ID,
        options: [{ label: { en: "A" }, value: "a" }],
      } as never,
      // A stored page carrying a question_id on a type whose answerKind is
      // "none". contact_info used to be the shipping example; SP9 gave it a
      // comparable answer, so the case that still reaches this guard is
      // stored JSON — a funnel authored through the API, or written before a
      // page type was removed. That is also the only way a clause can now
      // point at an unbranchable question, which is exactly what this test
      // is about.
      // clause referencing it is exactly the stale state Gap 1 covers.
      { id: "pg_contact", type: "info", question_id: STALE_QUESTION_ID } as never,
      { id: BRANCH_PAGE_ID, type: "info", title: { en: "Branch page" } } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {
      [BRANCH_PAGE_ID]: [
        {
          id: "r1",
          condition: {
            op: "all",
            clauses: [{ question_id: STALE_QUESTION_ID, op: "eq", value: STALE_CLAUSE_VALUE }],
          },
          goto: "end",
        },
      ],
    } as never,
    draftDefaultNext: {},
    draftDiffersFromPublished: false,
    defaultLocale: "en",
    locales: ["en"],
    updatedAt: "",
    createdAt: "",
  };
}

async function makeLoadedVm() {
  const container = new Container(tsyringeContainer);
  const api: Partial<FunnelApi> = {
    get: async () => fakeFunnel(),
    patchDraft: async () => fakeFunnel(),
    publish: async () => ({ funnel: fakeFunnel(), versionNo: 1 }),
    duplicate: async () => fakeFunnel(),
  };
  container.register(FunnelApi, { useValue: api as FunnelApi });
  const vm = container.resolve(FunnelDraftViewModel, { projectId: "p_1", funnelId: "f_1" });
  await vm.load(() => {});
  return vm;
}

function renderRuleEditor(vm: FunnelDraftViewModel) {
  return render(
    <ServiceProvider provide={[{ token: FunnelDraftViewModel, provider: { useValue: vm } }]}>
      <RuleEditor pageId={BRANCH_PAGE_ID} />
    </ServiceProvider>,
  );
}

describe("RuleEditor — stale clause pointing at a now-unbranchable question (Gap 1)", () => {
  it("renders a self-explaining broken row instead of a <select> whose displayed value diverges from stored state", async () => {
    const vm = await makeLoadedVm();
    const { container } = renderRuleEditor(vm);

    // The stored clause is untouched by rendering.
    const storedClause = vm.rules[BRANCH_PAGE_ID]![0]!.condition.clauses[0]!;
    expect(storedClause.question_id).toBe(STALE_QUESTION_ID);

    // No <select> in the tree may claim to represent this clause's
    // question while displaying a value other than what's stored — i.e.
    // no <select value={c.question_id}> whose real DOM value silently
    // fell back to some other option because STALE_QUESTION_ID isn't
    // among the <option>s (branchableQuestionIds excludes it).
    const selects = Array.from(container.querySelectorAll("select"));
    for (const select of selects) {
      const options = Array.from(select.options).map((o) => o.value);
      // Whatever the browser actually ends up showing for this control,
      // it must be one of its own declared options — never a value from
      // state ("stale") silently swapped for a different displayed one.
      expect(options).toContain(select.value);
    }

    // No <select> may exist that claims to hold STALE_QUESTION_ID as its
    // selected value (that would require it to be a valid <option>,
    // which branchableQuestionIds forbids).
    for (const select of selects) {
      expect(select.value).not.toBe(STALE_QUESTION_ID);
    }

    // The author must be told, visibly, that this clause is broken.
    expect(screen.getByText(/unavailable question/i)).toBeInTheDocument();

    // ...and must be able to resolve it explicitly (never silently).
    const removeButton = screen.getByTitle(/remove/i);
    expect(removeButton).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(removeButton);

    // Removing the sole clause of the sole rule drops the whole rule,
    // mirroring removeRule's own empty-list handling.
    expect(vm.rules[BRANCH_PAGE_ID] ?? []).toHaveLength(0);
  });
});
