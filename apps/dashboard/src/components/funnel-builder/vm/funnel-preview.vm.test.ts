import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { FunnelPreviewViewModel, type PreviewProps } from "./funnel-preview.vm";

function makeVm(
  pages: PreviewProps["pages"],
  rules: PreviewProps["rules"] = {},
  defaultNext: PreviewProps["defaultNext"] = {},
  editLocale: PreviewProps["editLocale"] = "en",
) {
  const container = new Container(tsyringeContainer);
  return container.resolve(FunnelPreviewViewModel, {
    pages,
    rules,
    defaultNext,
    startId: pages[0]?.id ?? null,
    editLocale,
  });
}

describe("FunnelPreviewViewModel", () => {
  it("walks sequentially when no rule matches", () => {
    const vm = makeVm([
      { id: "pg_1", type: "info", title: "A" },
      { id: "pg_2", type: "info", title: "B" },
      { id: "pg_pay", type: "paywall", headline: "Pay" },
    ]);
    expect(vm.currentPageId).toBe("pg_1");
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_2");
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_pay");
  });

  it("jumps via 'paywall' literal goto", () => {
    const vm = makeVm(
      [
        { id: "pg_1", type: "info", title: "A" },
        { id: "pg_2", type: "info", title: "B" },
        { id: "pg_pay", type: "paywall", headline: "Pay" },
      ],
      {},
      { pg_1: "paywall" },
    );
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_pay");
    expect(vm.reachedPaywall).toBe(true);
  });

  it("reset returns to start", () => {
    const vm = makeVm([
      { id: "pg_1", type: "info", title: "A" },
      { id: "pg_2", type: "info", title: "B" },
      { id: "pg_pay", type: "paywall" },
    ]);
    vm.answerAndAdvance(null, null);
    vm.reset();
    expect(vm.currentPageId).toBe("pg_1");
    expect(vm.answers.size).toBe(0);
  });
});
