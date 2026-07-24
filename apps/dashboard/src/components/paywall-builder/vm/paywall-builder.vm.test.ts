import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Container } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import { PaywallBuilderViewModel } from "./paywall-builder.vm";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { ApiError } from "../../../lib/api";
import { findNode } from "../tree-ops";
import {
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  emptyBuilderConfig,
  measureNodeTree,
  type BuilderConfig,
  type PackageListNode,
  type PaywallNode,
  type StackNode,
  type TextNode,
} from "@rovenue/shared/paywall";

function treeOpsFindNode(vm: PaywallBuilderViewModel, id: string): PaywallNode | null {
  return findNode(vm.config.root, id);
}

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
    status: "draft",
    publishedVersionId: null,
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

  // ----- Preview eligibility toggle -----
  it("previewEligible defaults false and toggles/sets", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.previewEligible).toBe(false);
    vm.togglePreviewEligible();
    expect(vm.previewEligible).toBe(true);
    vm.setPreviewEligible(false);
    expect(vm.previewEligible).toBe(false);
  });

  // ----- Overrides -----
  it("addOverride appends an empty-props override of the given kind", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addOverride("t1", "introEligible");
    const node = treeOpsFindNode(vm, "t1");
    expect(node?.overrides).toEqual([{ when: { kind: "introEligible" }, props: {} }]);
  });

  it("addOverride is a no-op for an unknown node id", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const before = vm.config;

    vm.addOverride("nope", "selected");
    expect(vm.config).toBe(before);
  });

  it("updateOverrideProps shallow-merges props into the override at index", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addOverride("t1", "introEligible");
    vm.updateOverrideProps("t1", 0, { key: "t1_alt_key" });
    const node = treeOpsFindNode(vm, "t1") as TextNode;
    expect(node.overrides).toEqual([{ when: { kind: "introEligible" }, props: { key: "t1_alt_key" } }]);

    vm.updateOverrideProps("t1", 0, { align: "center" });
    const node2 = treeOpsFindNode(vm, "t1") as TextNode;
    expect(node2.overrides?.[0]?.props).toEqual({ key: "t1_alt_key", align: "center" });
  });

  it("updateOverrideProps is a no-op for an out-of-range index", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const before = vm.config;

    vm.updateOverrideProps("t1", 0, { key: "x" });
    expect(vm.config).toBe(before);
  });

  it("removeOverride removes the override at index", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addOverride("t1", "introEligible");
    vm.addOverride("t1", "selected");
    vm.removeOverride("t1", 0);
    const node = treeOpsFindNode(vm, "t1") as TextNode;
    expect(node.overrides).toEqual([{ when: { kind: "selected" }, props: {} }]);
  });

  // ----- cellTemplate -----
  it("setCellTemplate('default') seeds a name+price stack and registers loc keys", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    const plId = vm.addNode("packageList", "root")!;
    vm.setCellTemplate(plId, "default");

    const pl = treeOpsFindNode(vm, plId) as PackageListNode;
    expect(pl.cellTemplate?.type).toBe("stack");
    if (pl.cellTemplate?.type !== "stack") throw new Error("expected stack");
    expect(pl.cellTemplate.children).toHaveLength(2);
    const [nameNode, priceNode] = pl.cellTemplate.children as TextNode[];
    expect(vm.config.localizations.en[nameNode.key]).toBe("{{packageName}}");
    expect(vm.config.localizations.en[priceNode.key]).toBe("{{price}}");
  });

  it("setCellTemplate('none') clears an existing cellTemplate", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    const plId = vm.addNode("packageList", "root")!;
    vm.setCellTemplate(plId, "default");
    expect((treeOpsFindNode(vm, plId) as PackageListNode).cellTemplate).toBeDefined();

    vm.setCellTemplate(plId, "none");
    expect((treeOpsFindNode(vm, plId) as PackageListNode).cellTemplate).toBeUndefined();
  });

  it("setCellTemplate is a no-op when the id isn't a packageList", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const before = vm.config;

    vm.setCellTemplate("t1", "default");
    expect(vm.config).toBe(before);
  });

  // ----- Warning-code split (mirrors the API gate's WARNING_CODES) -----
  it("classifies OVERRIDE_SELECTED_OUTSIDE_CELL as a warning, not a blocking error", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.addOverride("t1", "selected"); // t1 isn't inside any cellTemplate
    expect(vm.errorIssues.some((i) => i.code === "OVERRIDE_SELECTED_OUTSIDE_CELL")).toBe(false);
    expect(vm.warningIssues.some((i) => i.code === "OVERRIDE_SELECTED_OUTSIDE_CELL")).toBe(true);
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

  // ----- Canvas device state -----
  describe("canvas device state", () => {
    it("defaults to the iPhone 15 Pro and derives its platform", () => {
      const vm = makeVm({});
      expect(vm.canvasDevice).toBe("iphone15");
      expect(vm.canvasPlatform).toBe("ios");
      expect(vm.showSafeArea).toBe(false);
      expect(vm.showAllSizes).toBe(false);
    });

    it("setCanvasDevice updates the id and the derived platform", () => {
      const vm = makeVm({});
      vm.setCanvasDevice("pixel8");
      expect(vm.canvasDevice).toBe("pixel8");
      expect(vm.canvasPlatform).toBe("android");
    });

    it("setCanvasPlatform lands on that platform's first device", () => {
      const vm = makeVm({});
      vm.setCanvasPlatform("android");
      expect(vm.canvasDevice).toBe("pixel8");
      expect(vm.canvasPlatform).toBe("android");
      vm.setCanvasPlatform("ios");
      expect(vm.canvasDevice).toBe("iphone15");
    });

    it("toggles safe-area and all-sizes", () => {
      const vm = makeVm({});
      vm.toggleSafeArea();
      expect(vm.showSafeArea).toBe(true);
      vm.setSafeArea(false);
      expect(vm.showSafeArea).toBe(false);
      vm.toggleAllSizes();
      expect(vm.showAllSizes).toBe(true);
      vm.setAllSizes(false);
      expect(vm.showAllSizes).toBe(false);
    });
  });

  // ----- Blank default-locale copy -----
  describe("blank default-locale copy", () => {
    function detailWithBlankTitle() {
      const config = fakeConfig();
      config.localizations.en.t1_key = "";
      return fakeDetail({ builderConfig: config });
    }

    it("surfaces the blank string as an error and blocks publish", async () => {
      const get = vi.fn().mockResolvedValue(detailWithBlankTitle());
      const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
      await vm.load(() => {});

      expect(vm.errorIssues.map((i) => i.code)).toContain("EMPTY_LOC_VALUE");
      expect(vm.canPublish).toBe(false);
    });

    it("clears once the string is written", async () => {
      const get = vi.fn().mockResolvedValue(detailWithBlankTitle());
      const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
      await vm.load(() => {});

      // Pin the precondition here rather than leaning on the test above:
      // without it this passes vacuously the day the blank value stops
      // producing an issue at all.
      expect(vm.errorIssues.map((i) => i.code)).toContain("EMPTY_LOC_VALUE");

      vm.setLocaleText("t1_key", "en", "Unlock everything");

      expect(vm.errorIssues).toEqual([]);
    });
  });

  // ----- Publish / versions -----
  describe("publish flow", () => {
    function blockingConfig(): BuilderConfig {
      // packageList with no purchaseButton anywhere → MISSING_PURCHASE_BUTTON
      const config = emptyBuilderConfig("en");
      config.root.children.push({
        type: "packageList",
        id: "pl",
        packageIds: ["pkg_monthly"],
        cellLayout: "row",
      });
      return config;
    }

    const LIVE_VERSION = {
      id: "pwv_1",
      versionNo: 3,
      label: null,
      offeringId: "off_1",
      configFormatVersion: 2,
      publishedAt: "2026-07-23T00:00:00.000Z",
      publishedBy: "u_1",
      isLive: true,
    };

    const EMPTY_DIFF = {
      from: { versionNo: 3, label: null },
      to: { versionNo: null, label: null },
      entries: [],
    };

    it("canPublish is false while blocking issues exist", async () => {
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail({ builderConfig: blockingConfig() })),
        patchBuilderConfig: vi.fn(),
        listVersions: vi.fn().mockResolvedValue([]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await vm.load(() => {});

      expect(vm.errorIssues.length).toBeGreaterThan(0);
      expect(vm.canPublish).toBe(false);
    });

    it("canPublish is true for a clean draft", async () => {
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail()),
        patchBuilderConfig: vi.fn(),
        listVersions: vi.fn().mockResolvedValue([]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await vm.load(() => {});

      expect(vm.errorIssues).toEqual([]);
      expect(vm.canPublish).toBe(true);
    });

    it("publish() flushes the autosave, calls the API and refreshes versions", async () => {
      const publish = vi.fn().mockResolvedValue({ versionNo: 3 });
      const listVersions = vi.fn().mockResolvedValue([LIVE_VERSION]);
      const diff = vi.fn().mockResolvedValue(EMPTY_DIFF);
      const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail()),
        patchBuilderConfig,
        publish,
        listVersions,
        diff,
      });
      await vm.load(() => {});

      // Dirty the draft so saveNow() actually fires.
      vm.addNode("spacer", "root");
      await vm.publish();

      expect(patchBuilderConfig).toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith("p_1", "pw_1");
      expect(vm.versions[0]?.versionNo).toBe(3);
      expect(vm.status).toBe("published");
      expect(vm.publishState).toBe("idle");
      expect(vm.hasUnpublishedChanges).toBe(false);
    });

    it("publish() surfaces the server's blocking-issue error", async () => {
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail()),
        patchBuilderConfig: vi.fn(),
        publish: vi.fn().mockRejectedValue(new Error("PAYWALL_NOT_PUBLISHABLE")),
        listVersions: vi.fn().mockResolvedValue([]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await vm.load(() => {});

      await vm.publish();

      expect(vm.publishState).toBe("error");
      expect(vm.publishError).toContain("PAYWALL_NOT_PUBLISHABLE");
    });

    it("hasUnpublishedChanges is true when the diff is non-empty", async () => {
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail({ status: "published", publishedVersionId: "pwv_1" })),
        patchBuilderConfig: vi.fn(),
        listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
        diff: vi.fn().mockResolvedValue({
          from: { versionNo: 3, label: null },
          to: { versionNo: null, label: null },
          entries: [
            {
              kind: "changed",
              scope: "localization",
              nodeId: null,
              nodeType: null,
              field: "en.t1_key",
              from: '"Hi"',
              to: '"Hello"',
            },
          ],
        }),
      });
      await vm.load(() => {});

      expect(vm.hasUnpublishedChanges).toBe(true);
    });

    it("discardToPublished() replaces the working tree with the server's response", async () => {
      const resetConfig = emptyBuilderConfig("en");
      resetConfig.localizations.en.t1_key = "Live";
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail()),
        patchBuilderConfig: vi.fn(),
        discardToPublished: vi.fn().mockResolvedValue(fakeDetail({ builderConfig: resetConfig })),
        listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await vm.load(() => {});

      await vm.discardToPublished();

      expect(vm.config.localizations.en?.t1_key).toBe("Live");
      expect(vm.config.root.children).toEqual([]);
      expect(vm.isDirty).toBe(false);
    });

    it("revertTo() applies the server response and reloads the version list", async () => {
      const revertedConfig = emptyBuilderConfig("en");
      revertedConfig.localizations.en.t1_key = "Reverted";
      const listVersions = vi.fn().mockResolvedValue([LIVE_VERSION]);
      const revert = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: revertedConfig }));
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(fakeDetail()),
        patchBuilderConfig: vi.fn(),
        revert,
        listVersions,
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await vm.load(() => {});
      listVersions.mockClear();

      await vm.revertTo(2);

      expect(revert).toHaveBeenCalledWith("p_1", "pw_1", 2);
      expect(listVersions).toHaveBeenCalled();
      expect(vm.config.localizations.en?.t1_key).toBe("Reverted");
      expect(vm.config.root.children).toEqual([]);
      expect(vm.isDirty).toBe(false);
    });

    // Regression for the final whole-branch review's Important finding: an
    // autosave clears isDirty (draft == SERVER) but leaves the cached diff
    // reflecting the PRE-save draft, so hasUnpublishedChanges must not
    // collapse to false and light the "in sync" chip while the draft still
    // differs from what devices are served.
    it("hasUnpublishedChanges stays true after an autosaved edit (no in-sync lie)", async () => {
      const published = () =>
        fakeDetail({ status: "published", publishedVersionId: "pwv_1" });
      // Hold the post-save diff refetch open so we can observe the exact
      // window the bug lived in: isDirty already cleared by the save, but
      // the fresh diff not yet landed. A never-resolving promise leaves
      // loadDiff pending, so `diffStale` stays set.
      const heldDiff = new Promise<typeof EMPTY_DIFF>(() => {});
      const vm = makeVm({
        get: vi.fn().mockResolvedValue(published()),
        // Persisting the edit returns a still-published detail (the draft
        // changed, publish state did not).
        patchBuilderConfig: vi.fn().mockResolvedValue(published()),
        listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
        diff: vi
          .fn()
          .mockResolvedValueOnce(EMPTY_DIFF) // initial load → in sync
          .mockReturnValueOnce(heldDiff), // post-save refetch → held open
      });
      await vm.load(() => {});

      // Freshly loaded published paywall with an empty diff → in sync.
      expect(vm.hasUnpublishedChanges).toBe(false);

      vm.addNode("spacer", "root");
      expect(vm.isDirty).toBe(true);
      expect(vm.hasUnpublishedChanges).toBe(true);

      await vm.saveNow();

      // The edit is now persisted → isDirty is cleared, and the cached diff
      // is stale (the refetch is still in flight). Pre-fix this read false
      // ("in sync" lie); the diffStale flag keeps it truthful until a fresh
      // diff lands.
      expect(vm.isDirty).toBe(false);
      expect(vm.hasUnpublishedChanges).toBe(true);
    });

    it("canPublish gates on hasUnpublishedChanges (no identical-version spam)", async () => {
      // In-sync published paywall: nothing to publish → canPublish false.
      const inSync = makeVm({
        get: vi.fn().mockResolvedValue(
          fakeDetail({ status: "published", publishedVersionId: "pwv_1" }),
        ),
        patchBuilderConfig: vi.fn(),
        listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await inSync.load(() => {});
      expect(inSync.errorIssues).toEqual([]);
      expect(inSync.hasUnpublishedChanges).toBe(false);
      expect(inSync.canPublish).toBe(false);

      // An edit makes it publishable again.
      inSync.addNode("spacer", "root");
      expect(inSync.canPublish).toBe(true);

      // Never-published paywall always has changes → first publish enabled.
      const fresh = makeVm({
        get: vi.fn().mockResolvedValue(
          fakeDetail({ status: "draft", publishedVersionId: null }),
        ),
        patchBuilderConfig: vi.fn(),
        listVersions: vi.fn().mockResolvedValue([]),
        diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
      });
      await fresh.load(() => {});
      expect(fresh.hasUnpublishedChanges).toBe(true);
      expect(fresh.canPublish).toBe(true);
    });
  });

  describe("an incomplete draft is still unpublishable", () => {
    it("keeps canPublish false when a package list has no purchase button", async () => {
      const config = fakeConfig();
      config.root.children.push({ type: "packageList", id: "pl", packageIds: [], cellLayout: "row" });
      const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
      const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
      await vm.load(() => {});

      expect(vm.errorIssues.map((i) => i.code)).toContain("MISSING_PURCHASE_BUTTON");
      expect(vm.canPublish).toBe(false);
    });
  });

  describe("autosave failure kinds", () => {
    it("marks a 4xx from the write path as permanent", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INVALID_BUILDER_CONFIG", "nope", 400));
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setLocaleText("t1_key", "en", "changed");
      await vm.saveNow();

      expect(vm.autosaveStatus).toBe("permanentError");
    });

    it("marks a 5xx as retryable", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INTERNAL", "boom", 500));
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setLocaleText("t1_key", "en", "changed");
      await vm.saveNow();

      expect(vm.autosaveStatus).toBe("error");
    });

    it("does not launder a permanent failure into 'saving' on the next edit", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INVALID_BUILDER_CONFIG", "nope", 400));
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setLocaleText("t1_key", "en", "changed");
      await vm.saveNow();
      expect(vm.autosaveStatus).toBe("permanentError");

      vm.clearAutosaveError();

      expect(vm.autosaveStatus).toBe("permanentError");
    });

    it("still clears a retryable failure so the next attempt reads as in flight", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INTERNAL", "boom", 500));
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setLocaleText("t1_key", "en", "changed");
      await vm.saveNow();
      vm.clearAutosaveError();

      expect(vm.autosaveStatus).toBe("saving");
    });
  });

  describe("flushing pending work", () => {
    it("saveNow() PATCHes when there are unsaved edits", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setLocaleText("t1_key", "en", "changed");
      expect(vm.isDirty).toBe(true);

      await vm.saveNow();

      expect(patchBuilderConfig).toHaveBeenCalledTimes(1);
    });

    it("saveNow() does not PATCH when nothing changed", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      await vm.saveNow();

      expect(patchBuilderConfig).not.toHaveBeenCalled();
    });
  });
});

describe("reopen after an unmount flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A promise plus the handles to settle it, so the test controls ordering
   * instead of racing a timer. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("waits for an in-flight flush before loading, so the GET cannot read the pre-flush row", async () => {
    const order: string[] = [];

    const flushGate = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockImplementation(() => {
        order.push("patch:start");
        return flushGate.promise;
      }),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");

    // The unmount flush — deliberately not awaited, exactly as BuilderShell does it.
    void oldVm.saveNow();
    await Promise.resolve();

    const newVm = makeVm({
      get: vi.fn().mockImplementation(async () => {
        order.push("get");
        return fakeDetail();
      }),
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});
    await Promise.resolve();

    // The GET must not have fired yet — the flush is still open.
    expect(order).toEqual(["patch:start"]);

    flushGate.resolve(fakeDetail());
    await loading;

    expect(order).toEqual(["patch:start", "get"]);
  });

  it("keeps the barrier up when an older overlapping flush settles first", async () => {
    const order: string[] = [];
    const gate1 = deferred<PaywallBuilderDetailDto>();
    const gate2 = deferred<PaywallBuilderDetailDto>();
    let call = 0;

    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockImplementation(() => {
        call += 1;
        order.push(`patch${call}:start`);
        return call === 1 ? gate1.promise : gate2.promise;
      }),
    });
    await oldVm.load(() => {});

    oldVm.setLocaleText("t1_key", "en", "first");
    void oldVm.saveNow();
    await Promise.resolve();

    // A second save on the SAME instance — reachable because isDirty stays
    // true until a save succeeds, so publish() and the unmount flush can
    // both fire. This aborts call 1's controller.
    oldVm.setLocaleText("t1_key", "en", "second");
    void oldVm.saveNow();
    await Promise.resolve();

    // The OLDER call settles first. Its cleanup must not clear the barrier,
    // because call 2's PATCH is still open. Drain enough microtasks for the
    // whole run -> catch -> finally chain of call 1 to complete: with fewer
    // ticks the cleanup has not run yet when `load()` reads the barrier, and
    // the test would pass even with the bug present.
    gate1.resolve(fakeDetail());
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const newVm = makeVm({
      get: vi.fn().mockImplementation(async () => {
        order.push("reopen:get");
        return fakeDetail();
      }),
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});
    await Promise.resolve();

    expect(order).toEqual(["patch1:start", "patch2:start"]);

    gate2.resolve(fakeDetail());
    await loading;

    expect(order).toEqual(["patch1:start", "patch2:start", "reopen:get"]);
  });

  it("gives up on a flush that never settles instead of wedging the builder", async () => {
    // `pendingFlush` is module-scoped, so a flush left unsettled here would
    // leak into the NEXT test and hang it. The gate is therefore resolved at
    // the end of this test rather than abandoned.
    const hung = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockReturnValue(hung.promise),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");
    void oldVm.saveNow();
    await Promise.resolve();

    const newVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});
    await Promise.resolve();
    expect(newVm.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await loading;

    expect(newVm.isLoading).toBe(false);
    expect(newVm.error).toBeNull();

    hung.resolve(fakeDetail());
    await Promise.resolve();
  });

  // NOTE: this cannot fail today, and that is worth stating rather than
  // dressing it up. `saveNowInner` catches its own errors (it sets
  // autosaveStatus and does not rethrow), so the flush promise never
  // rejects and the barrier's `.catch()` is belt-and-braces. The test is a
  // guard for the day someone makes saveNow rethrow: at that moment the
  // `.catch()` is the only thing keeping a failed save from turning into a
  // builder that never opens.
  it("does not wedge the reopen when the flush fails", async () => {
    const flushGate = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockImplementation(() => flushGate.promise),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");
    void oldVm.saveNow();
    await Promise.resolve();

    const newVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
    });
    // Start the load FIRST so it is parked on the barrier, then fail the
    // flush. Rejecting before the load starts would clear `pendingFlush`
    // via its `finally`, so the load would never await it and the test
    // would pass without exercising the rejection path at all.
    const loading = newVm.load(() => {});
    await Promise.resolve();
    flushGate.reject(new Error("boom"));
    await loading;

    expect(newVm.isLoading).toBe(false);
    expect(newVm.error).toBeNull();
  });
});

describe("size caps", () => {
  it("refuses to add a node past the node cap and leaves the tree unchanged", async () => {
    const config = fakeConfig();
    // One under the cap counting the root itself.
    while (measureNodeTree(config).nodes < MAX_BUILDER_NODES) {
      config.root.children.push({ type: "spacer", id: `s${config.root.children.length}`, size: 4 });
    }
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    const before = vm.config.root.children.length;
    expect(vm.addNode("spacer", "root")).toBeNull();
    expect(vm.config.root.children.length).toBe(before);
    expect(vm.atNodeCapacity).toBe(true);
  });

  it("refuses to add past the depth cap", async () => {
    const config = fakeConfig();
    // Nest stacks until the tree is exactly at the depth cap, keeping a
    // handle on the deepest one. Typed as StackNode so `.children` stays
    // addressable — `config.root.children` is a PaywallNode[].
    let cursor: StackNode = config.root;
    let n = 0;
    while (measureNodeTree(config).depth < MAX_BUILDER_DEPTH) {
      const child: StackNode = { type: "stack", id: `st${n++}`, axis: "v", children: [] };
      cursor.children.push(child);
      cursor = child;
    }
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.addNode("spacer", cursor.id)).toBeNull();
  });

  it("still adds when there is room", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.addNode("spacer", "root")).toEqual(expect.any(String));
    expect(vm.atNodeCapacity).toBe(false);
  });
});
