import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { PaywallBuilderViewModel } from "./paywall-builder.vm";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({ type: "text", id: "t1", key: "t1_key", role: "title" });
  config.localizations.en.t1_key = "Hello";
  return config;
}

function fakeDetail(overrides: Partial<PaywallBuilderDetailDto> = {}): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    builderConfig: fakeConfig(),
    defaultLocale: "en",
    offeringPackageIds: ["pkg_monthly", "pkg_annual"],
    updatedAt: "",
    createdAt: "",
    ...overrides,
  };
}

function makeVm(api: Partial<PaywallBuilderApi>) {
  const container = new Container(tsyringeContainer);
  container.register(PaywallBuilderApi, { useValue: api as PaywallBuilderApi });
  return container.resolve(PaywallBuilderViewModel, { projectId: "p_1", paywallId: "pw_1" });
}

describe("PaywallBuilderViewModel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("loads on mount and applies the server config", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    expect(vm.isLoading).toBe(false);
    expect(vm.config.root.children).toHaveLength(1);
    expect(vm.defaultLocale).toBe("en");
    expect(vm.locales).toEqual(["en"]);
    expect(vm.isDirty).toBe(false);
  });

  it("seeds an empty config when the paywall has no builderConfig yet", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: null, defaultLocale: "fr" }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    expect(vm.config.root.children).toEqual([]);
    expect(vm.defaultLocale).toBe("fr");
  });

  // ----- Dirty snapshot -----
  it("is dirty after a node mutation and clean again after load", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    expect(vm.isDirty).toBe(false);

    vm.updateNode("t1", { role: "subtitle" });
    expect(vm.isDirty).toBe(true);
  });

  it("addNode marks dirty, selects the new node, and registers empty loc keys in every locale", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");

    const id = vm.addNode("text", "root");
    expect(vm.isDirty).toBe(true);
    expect(vm.selectedNodeId).toBe(id);
    expect(vm.config.localizations.en[`text_${id}`]).toBe("");
    expect(vm.config.localizations.tr[`text_${id}`]).toBe("");
  });

  it("removeNode clears selection when the removed node was selected", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");
    vm.removeNode("t1");
    expect(vm.selectedNodeId).toBeNull();
    expect(vm.config.root.children).toHaveLength(0);
  });

  // ----- Presets -----
  it("applyPreset('hero') produces a config with zero blocking validation issues", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: [] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.applyPreset("hero");
    expect(vm.errorIssues).toEqual([]);
  });

  it("applyPreset('comparison') produces a config with zero blocking validation issues", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: [] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.applyPreset("comparison");
    expect(vm.errorIssues).toEqual([]);
  });

  it("applyPreset marks the VM dirty and clears selection", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");

    vm.applyPreset("hero");
    expect(vm.isDirty).toBe(true);
    expect(vm.selectedNodeId).toBeNull();
  });

  // ----- Locale ops -----
  it("addLocale appends to locales and switches editLocale", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addLocale("TR");
    expect(vm.locales).toEqual(["en", "tr"]);
    expect(vm.editLocale).toBe("tr");
    expect(vm.config.localizations.tr).toEqual({});
  });

  it("removeLocale reassigns the default locale when the default is removed", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");
    expect(vm.defaultLocale).toBe("en");

    vm.removeLocale("en");
    expect(vm.config.localizations.en).toBeUndefined();
    expect(vm.defaultLocale).toBe("tr");
    expect(vm.locales).toEqual(["tr"]);
  });

  it("removeLocale is a no-op when it's the only remaining locale", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.removeLocale("en");
    expect(vm.locales).toEqual(["en"]);
  });

  it("removeLocale falls back editLocale off the removed locale", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");
    expect(vm.editLocale).toBe("tr");

    vm.removeLocale("tr");
    expect(vm.editLocale).toBe("en");
  });

  // ----- Localized text -----
  it("setLocaleText writes into the given locale's table", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", vm.editLocale, "Bonjour");
    expect(vm.config.localizations[vm.editLocale].t1_key).toBe("Bonjour");
  });

  it("setLocaleText is a no-op for an unregistered locale", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "zz", "nope");
    expect(vm.config.localizations.zz).toBeUndefined();
  });

  // ----- Validation issues -----
  it("flags FOREIGN_PACKAGE_ID for a packageList referencing an id outside the offering", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: ["pkg_monthly"] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addNode("packageList", "root");
    vm.updateNode(vm.config.root.children[1].id, { packageIds: ["pkg_unknown"] });
    expect(vm.errorIssues.some((i) => i.code === "FOREIGN_PACKAGE_ID")).toBe(true);
  });

  // ----- Save -----
  it("saveNow is a no-op when clean", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn();
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    await vm.saveNow();
    expect(patchBuilderConfig).not.toHaveBeenCalled();
    expect(vm.autosaveStatus).toBe("saved");
  });

  it("saveNow PATCHes the config and updates lastSavedSnapshot", async () => {
    const detail = fakeDetail();
    const get = vi.fn().mockResolvedValue(detail);
    // Realistic mock: the API echoes back the builderConfig it was sent
    // (mirrors the real PATCH response, which re-validates and persists it).
    const patchBuilderConfig = vi
      .fn()
      .mockImplementation((_p: string, _id: string, config: BuilderConfig) =>
        Promise.resolve(fakeDetail({ builderConfig: config })),
      );
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.updateNode("t1", { role: "body" });
    expect(vm.isDirty).toBe(true);
    const sentConfig = vm.config;
    await vm.saveNow();

    expect(patchBuilderConfig).toHaveBeenCalledWith(
      "p_1",
      "pw_1",
      sentConfig,
      detail.offeringId,
      detail.offeringPackageIds,
      expect.anything(),
    );
    expect(vm.isDirty).toBe(false);
    expect(vm.autosaveStatus).toBe("saved");
  });

  it("autosave throttles rapid mutations into one trailing PATCH per 30s", async () => {
    const detail = fakeDetail();
    const get = vi.fn().mockResolvedValue(detail);
    const patchBuilderConfig = vi.fn().mockResolvedValue(detail);
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});
    await vi.advanceTimersByTimeAsync(30_001);
    patchBuilderConfig.mockClear();

    vm.updateNode("t1", { role: "body" });
    vm.updateNode("t1", { role: "caption" });
    await vi.advanceTimersByTimeAsync(100);
    const beforeWindow = patchBuilderConfig.mock.calls.length;
    expect(beforeWindow).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(patchBuilderConfig.mock.calls.length).toBeGreaterThanOrEqual(beforeWindow);
  });
});
