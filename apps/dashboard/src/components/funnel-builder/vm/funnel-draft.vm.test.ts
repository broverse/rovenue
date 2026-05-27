import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { FunnelDraftViewModel } from "./funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";

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
      { id: "pg_1", type: "info", title: "Hi" } as never,
      { id: "pg_pay", type: "paywall", headline: "x", benefits: ["a"] } as never,
      { id: "pg_done", type: "success", title: "Done", body: "Open" } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {},
    draftDefaultNext: {},
    draftDiffersFromPublished: false,
    updatedAt: "",
    createdAt: "",
  };
}

function makeVm(api: Partial<FunnelApi>) {
  const container = new Container(tsyringeContainer);
  container.register(FunnelApi, { useValue: api as FunnelApi });
  return container.resolve(FunnelDraftViewModel, { projectId: "p_1", funnelId: "f_1" });
}

describe("FunnelDraftViewModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("loads on mount and surfaces pages", async () => {
    const get = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm({ get, patchDraft: vi.fn(), publish: vi.fn(), duplicate: vi.fn() });
    await vm.load(() => {});
    expect(vm.isLoading).toBe(false);
    expect(vm.pages.length).toBe(3);
    expect(vm.selectedPageId).toBe("pg_1");
  });

  it("autosave debounces mutations into one PATCH", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeFunnel()),
      patchDraft,
      publish: vi.fn(),
      duplicate: vi.fn(),
    });
    await vm.load(() => {});
    vm.rename("renamed");
    vm.rename("renamed again");
    vm.updatePage("pg_1", { title: "Bonjour" });
    expect(patchDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(patchDraft).toHaveBeenCalledTimes(1);
    expect(patchDraft.mock.calls[0][2].name).toBe("renamed again");
  });

  it("errorCount reflects validator output", async () => {
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeFunnel()),
      patchDraft: vi.fn().mockResolvedValue(fakeFunnel()),
      publish: vi.fn(),
      duplicate: vi.fn(),
    });
    await vm.load(() => {});
    expect(vm.errorCount).toBe(0);
    vm.removePage("pg_pay");
    expect(vm.errorCount).toBeGreaterThan(0);
  });
});
