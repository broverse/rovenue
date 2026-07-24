import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { FunnelDraftViewModel } from "./funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";

// Covers I-1/I-2 together: branching-schema.ts now rejects a string operand
// for gt/gte/lt/lte/between, but the rule editor only coerces on blur
// (coerceOperandValue's doc comment explains why — per-keystroke coercion
// makes "1.5" untypeable). The throttled autosave firing mid-type, or a
// re-render that unmounts the operand input without a blur ever running,
// would otherwise ship the raw string and turn ordinary typing into a save
// error. coercedRules() is the backstop that re-coerces right before the
// draft leaves the VM.
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
      { id: "pg_num", type: "number_input", question_id: "q_age", title: "Age" } as never,
      { id: "pg_info", type: "info", title: "Hi" } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {
      pg_num: [
        {
          id: "r1",
          condition: { op: "all", clauses: [{ question_id: "q_age", op: "gt", value: 5 }] },
          goto: "pg_info",
        },
      ],
    },
    draftDefaultNext: {},
    draftDiffersFromPublished: false,
    defaultLocale: "en",
    locales: ["en"],
    updatedAt: "",
    createdAt: "",
  };
}

function makeVm(patchDraft: ReturnType<typeof vi.fn>) {
  const container = new Container(tsyringeContainer);
  container.register(FunnelApi, {
    useValue: {
      get: vi.fn().mockResolvedValue(fakeFunnel()),
      patchDraft,
      publish: vi.fn(),
      duplicate: vi.fn(),
    } as unknown as FunnelApi,
  });
  return container.resolve(FunnelDraftViewModel, { projectId: "p_1", funnelId: "f_1" });
}

type ShippedClause = { op: string; value: unknown };
function shippedClause(patchDraft: ReturnType<typeof vi.fn>, pageId: string): ShippedClause {
  const payload = patchDraft.mock.calls[0]![2] as {
    draftRules?: Record<string, { condition: { clauses: ShippedClause[] } }[]>;
  };
  return payload.draftRules![pageId]![0]!.condition.clauses[0]!;
}

describe("FunnelDraftViewModel — coercedRules at the save boundary", () => {
  it("coerces a still-string numeric operand before it ships to the server", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm(patchDraft);
    await vm.load(() => {});

    // Simulates onChange having written the raw string with blur never
    // running — the gap I-2 closes.
    vm.updateRule("pg_num", 0, {
      condition: { op: "all", clauses: [{ question_id: "q_age", op: "gt", value: "5" } as never] },
    });

    await vm.saveNow();

    const clause = shippedClause(patchDraft, "pg_num");
    expect(clause.value).toBe(5);
    expect(typeof clause.value).toBe("number");
  });

  it("leaves a genuinely incomplete numeric operand untouched, not NaN", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm(patchDraft);
    await vm.load(() => {});

    vm.updateRule("pg_num", 0, {
      condition: { op: "all", clauses: [{ question_id: "q_age", op: "gt", value: "-" } as never] },
    });

    await vm.saveNow();

    const clause = shippedClause(patchDraft, "pg_num");
    expect(clause.value).toBe("-");
  });

  it("does not disturb an already-numeric operand", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm(patchDraft);
    await vm.load(() => {});

    await vm.saveNow();
    // Nothing changed the VM's rules, so isDirty is false and saveNow is a
    // no-op — force a real change first so the PATCH actually fires.
    vm.updateRule("pg_num", 0, {
      condition: { op: "all", clauses: [{ question_id: "q_age", op: "gt", value: 7 } as never] },
    });
    await vm.saveNow();

    const clause = shippedClause(patchDraft, "pg_num");
    expect(clause.value).toBe(7);
  });

  it("coerces both bounds of a still-string 'between' pair", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm(patchDraft);
    await vm.load(() => {});

    vm.updateRule("pg_num", 0, {
      condition: {
        op: "all",
        clauses: [{ question_id: "q_age", op: "between", value: ["18", "65"] } as never],
      },
    });

    await vm.saveNow();

    const clause = shippedClause(patchDraft, "pg_num");
    expect(clause.value).toEqual([18, 65]);
  });
});
