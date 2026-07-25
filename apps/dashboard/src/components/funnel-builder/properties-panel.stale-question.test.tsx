import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Container, ServiceProvider } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../lib/services/funnel-api";

// =============================================================
// Gap 2 (SP5 stale-clause fix): properties-panel.tsx computed a single
// unfiltered `earlierQs` and used it for two different purposes — the
// branching gate (must exclude answerKind "none" questions, same as
// rule-editor.tsx's branchableQuestionIds) and the "insert from earlier
// questions" personalization chips (must NOT exclude them — a
// contact_info answer is perfectly insertable into result copy). This
// proves the split holds: the branching gate uses the filtered list,
// the personalization chips use the unfiltered one.
// =============================================================

vi.mock("../../lib/hooks/useProjectPaywalls", () => ({
  useProjectPaywalls: () => ({ data: { paywalls: [] } }),
}));

// Imported after the mock above so the mocked module is in place first.
const { PropertiesPanel } = await import("./properties-panel");

const STALE_QUESTION_ID = "q_contact";
const CONTACT_PAGE_ID = "pg_contact";
const BRANCH_TARGET_PAGE_ID = "pg_branch_target";
const RESULT_PAGE_ID = "pg_result";

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
      // contact_info is the ONLY earlier question for both pages below —
      // it carries a question_id but answerKind "none".
      { id: CONTACT_PAGE_ID, type: "contact_info", question_id: STALE_QUESTION_ID } as never,
      { id: BRANCH_TARGET_PAGE_ID, type: "info", title: { en: "Branch target" } } as never,
      { id: RESULT_PAGE_ID, type: "result", title: { en: "Result" } } as never,
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

async function makeLoadedVm(selectedPageId: string) {
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
  vm.selectPage(selectedPageId);
  return vm;
}

function renderPanel(vm: FunnelDraftViewModel) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ServiceProvider provide={[{ token: FunnelDraftViewModel, provider: { useValue: vm } }]}>
        <PropertiesPanel editLocale="en" defaultLocale="en" />
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

describe("PropertiesPanel — branching gate vs personalization chips (Gap 2)", () => {
  it("branching gate now OPENS for a contact_info-only earlier question", async () => {
    // Inverted deliberately by SP9. contact_info was the one page type
    // carrying a question_id while classified "none", which is why it was
    // the example of an earlier question that did not count for branching.
    // It now has answerKind "composite" and offers is_answered, so a rule
    // keyed on it is one an author can legitimately write and the gate must
    // not claim there is nothing to branch on.
    //
    // The gate's own filtering (branchableQuestionIds) is still covered —
    // see rule-editor.branching.test.ts, which exercises it with the case
    // that can still reach it: stored JSON carrying a question_id on a
    // none-kind type.
    const vm = await makeLoadedVm(BRANCH_TARGET_PAGE_ID);
    renderPanel(vm);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Branching/i }));

    expect(screen.queryByText(/No earlier questions yet/i)).not.toBeInTheDocument();
  });

  it("personalization chips still offer a contact_info-only earlier question", async () => {
    const vm = await makeLoadedVm(RESULT_PAGE_ID);
    renderPanel(vm);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Personalization/i }));

    expect(screen.getByText(`{{${STALE_QUESTION_ID}}}`)).toBeInTheDocument();
  });
});
