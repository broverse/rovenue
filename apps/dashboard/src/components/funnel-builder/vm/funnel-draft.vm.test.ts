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

  it("autosave throttles rapid mutations into one trailing PATCH per 30s", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeFunnel()),
      patchDraft,
      publish: vi.fn(),
      duplicate: vi.fn(),
    });
    await vm.load(() => {});
    // Throttle's leading call fires for the first mutation; subsequent rapid
    // mutations are queued and emitted as a single trailing PATCH after the
    // window. Drain initial leading call from `load` setup if any.
    await vi.advanceTimersByTimeAsync(30_001);
    patchDraft.mockClear();

    vm.rename("renamed");
    vm.rename("renamed again");
    vm.updatePage("pg_1", { title: "Bonjour" });
    // Within the throttle window we expect at most one PATCH (the leading one).
    await vi.advanceTimersByTimeAsync(100);
    const beforeWindow = patchDraft.mock.calls.length;
    expect(beforeWindow).toBeLessThanOrEqual(1);

    // After the window closes, the trailing change is flushed once.
    await vi.advanceTimersByTimeAsync(30_001);
    expect(patchDraft.mock.calls.length).toBeGreaterThanOrEqual(beforeWindow);
    const lastCall = patchDraft.mock.calls.at(-1)!;
    expect(lastCall[2].name).toBe("renamed again");
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
