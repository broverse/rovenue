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
  TreeOpError,
  emptyBuilderConfig,
  measureNodeTree,
  type BuilderConfig,
  type FeatureListNode,
  type PackageListNode,
  type PaywallNode,
  type PaywallTreeOp,
  type StackNode,
  type TextNode,
  type TimelineNode,
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

  it("addNode('featureList'/'timeline') stubs the starter row's labelKey in every locale", async () => {
    // registerFreshLocKeys reads from `localizedKeysOf` (the same table
    // validate.ts/nodeLocKey read) rather than a hand-maintained per-type
    // list, so these two — which carry copy on a ROW, not the node itself —
    // get stubbed exactly like text/button/purchaseButton do.
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");

    const flId = vm.addNode("featureList", "root");
    const flNode = treeOpsFindNode(vm, flId!) as FeatureListNode;
    const flKey = flNode.rows[0]!.labelKey;
    expect(vm.config.localizations.en[flKey]).toBe("");
    expect(vm.config.localizations.tr[flKey]).toBe("");

    const tlId = vm.addNode("timeline", "root");
    const tlNode = treeOpsFindNode(vm, tlId!) as TimelineNode;
    const tlKey = tlNode.rows[0]!.labelKey;
    expect(vm.config.localizations.en[tlKey]).toBe("");
    expect(vm.config.localizations.tr[tlKey]).toBe("");
  });

  it("addNode('divider') stubs no loc keys — a divider carries no copy", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const keysBefore = Object.keys(vm.config.localizations.en);

    vm.addNode("divider", "root");
    expect(Object.keys(vm.config.localizations.en)).toEqual(keysBefore);
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

  // ----- moveNodeTo (Layers panel drag-and-drop) -----
  it("moveNodeTo marks dirty and re-parents the node", async () => {
    const config = fakeConfig();
    config.root.children.unshift({ type: "stack", id: "group1", axis: "v", children: [] });
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    expect(vm.isDirty).toBe(false);

    vm.moveNodeTo("t1", "group1", 0);

    expect(vm.isDirty).toBe(true);
    const group = findNode(vm.config.root, "group1") as StackNode;
    expect(group.children.map((c) => c.id)).toEqual(["t1"]);
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["group1"]);
  });

  it("moveNodeTo is a full no-op — config untouched, not dirty — when the move is illegal", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const configBefore = vm.config;
    expect(vm.isDirty).toBe(false);

    // "t1" is not a container — an illegal target parent, per tree-ops.
    vm.moveNodeTo("root", "t1", 0);

    expect(vm.isDirty).toBe(false);
    expect(vm.config).toBe(configBefore);
  });

  // ----- Presets -----
  // Task 8b: the hero preset's own `hero_image` ships with `url: { light: "" }`
  // on purpose — an author applies the template and picks real art next. That
  // used to read as zero issues, which was the bug Task 8b closes: nothing
  // caught a blank hero image before publish. Now EMPTY_MEDIA_URL flags it,
  // and EMPTY_ACTION_URL flags the footer's Terms/Privacy links, which a
  // template cannot fill in either. Both are publish-tier, so the template
  // still applies cleanly and stays editable.
  it("applyTemplate('hero') raises the placeholder codes and ONLY those", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: [] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.applyTemplate("hero");
    // The blank hero image, plus the footer's Terms/Privacy links, which no
    // template can fill in on a project's behalf. Both publish-tier: the
    // template still applies cleanly and stays editable.
    expect(new Set(vm.errorIssues.map((i) => i.code))).toEqual(
      new Set(["EMPTY_MEDIA_URL", "EMPTY_ACTION_URL"]),
    );
    expect(vm.errorIssues).toContainEqual(
      expect.objectContaining({ code: "EMPTY_MEDIA_URL", nodeId: "hero_img_image" }),
    );
  });

  it("applyTemplate('comparison') raises only its footer's EMPTY_ACTION_URL — it carries no media", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: [] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.applyTemplate("comparison");
    expect(new Set(vm.errorIssues.map((i) => i.code))).toEqual(new Set(["EMPTY_ACTION_URL"]));
  });

  it("applyTemplate marks the VM dirty and clears selection", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");

    vm.applyTemplate("hero");
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

  // ----- Localization modal jump-to-translation -----
  it("openLocalizationModal sets the pending focus key", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.localizationFocusKey).toBeNull();
    vm.openLocalizationModal("t1_key");
    expect(vm.localizationFocusKey).toBe("t1_key");
  });

  it("openLocalizationModal with no key opens unfocused, same as the top bar's own opener", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.openLocalizationModal("t1_key");
    vm.openLocalizationModal();
    expect(vm.localizationFocusKey).toBeNull();
  });

  it("clearLocalizationFocusKey resets the focus so reopening later starts unfocused", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.openLocalizationModal("t1_key");
    vm.clearLocalizationFocusKey();
    expect(vm.localizationFocusKey).toBeNull();
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

  // ----- P9 on-device preview: active-preview fast flush -----
  // A physical device polls the persisted draft while a preview session is
  // open, so an edit made during that window should land far sooner than
  // the ordinary 30s autosave throttle (`PREVIEW_FLUSH_DEBOUNCE_MS`, 2000ms
  // — hardcoded here rather than imported, matching this file's existing
  // convention for FLUSH_BARRIER_TIMEOUT_MS/the 30s throttle above).
  describe("previewSessionActive fast flush", () => {
    it("previewSessionActive defaults false and toggles via setPreviewSessionActive", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
      await vm.load(() => {});

      expect(vm.previewSessionActive).toBe(false);
      vm.setPreviewSessionActive(true);
      expect(vm.previewSessionActive).toBe(true);
    });

    it("with previewSessionActive true, an edit triggers a debounced saveNow within PREVIEW_FLUSH_DEBOUNCE_MS", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.setPreviewSessionActive(true);
      vm.updateNode("t1", { role: "body" });
      expect(patchBuilderConfig).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);

      expect(patchBuilderConfig).toHaveBeenCalledTimes(1);
      expect(vm.isDirty).toBe(false);
    });

    it("with previewSessionActive false, an edit does not trigger an early flush (30s throttle unaffected)", async () => {
      const get = vi.fn().mockResolvedValue(fakeDetail());
      const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
      const vm = makeVm({ get, patchBuilderConfig });
      await vm.load(() => {});

      vm.updateNode("t1", { role: "body" });
      await vi.advanceTimersByTimeAsync(2000);

      expect(patchBuilderConfig).not.toHaveBeenCalled();
      expect(vm.isDirty).toBe(true);
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

  it("barriers a revert too, not just the unmount flush", async () => {
    const order: string[] = [];
    const revertGate = deferred<PaywallBuilderDetailDto>();

    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
      revert: vi.fn().mockImplementation(() => {
        order.push("revert:start");
        return revertGate.promise;
      }),
      refreshPublishState: undefined,
    } as never);
    await oldVm.load(() => {});

    // revertTo rewrites the draft server-side, so a builder reopened while
    // it is open would read the pre-revert row and later overwrite it.
    void oldVm.revertTo(1);
    await Promise.resolve();

    const newVm = makeVm({
      get: vi.fn().mockImplementation(async () => {
        order.push("reopen:get");
        return fakeDetail();
      }),
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});
    await Promise.resolve();

    expect(order).toEqual(["revert:start"]);

    revertGate.resolve(fakeDetail());
    await loading;

    expect(order).toEqual(["revert:start", "reopen:get"]);
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

  it("errors instead of loading a row it knows is stale when the flush never settles", async () => {
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

    const get = vi.fn().mockResolvedValue(fakeDetail());
    const newVm = makeVm({
      get,
      patchBuilderConfig: vi.fn(),
    });
    const loading = newVm.load(() => {});
    await Promise.resolve();
    expect(newVm.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(15000);
    await loading;

    // Must NOT have proceeded to the GET — that row is known-stale at this
    // point (the flush is still open), so reading it would silently
    // resurrect the overwrite this barrier exists to prevent.
    expect(get).not.toHaveBeenCalled();
    expect(newVm.isLoading).toBe(false);
    expect(newVm.error).not.toBeNull();

    hung.resolve(fakeDetail());
    await Promise.resolve();
  });

  it("does not penalize a builder opened after a flush timed out", async () => {
    // First open: times out and errors (same setup as the test above).
    const hung = deferred<PaywallBuilderDetailDto>();
    const oldVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn().mockReturnValue(hung.promise),
    });
    await oldVm.load(() => {});
    oldVm.setLocaleText("t1_key", "en", "flushed");
    void oldVm.saveNow();
    await Promise.resolve();

    const firstVm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
    });
    const firstLoad = firstVm.load(() => {});
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    await firstLoad;
    expect(firstVm.error).not.toBeNull();

    // Second open, afterwards: `pendingFlush` must have been cleared by the
    // timed-out load, so this one loads normally and immediately, without
    // waiting on anything.
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const secondVm = makeVm({ get, patchBuilderConfig: vi.fn() });
    const secondLoad = secondVm.load(() => {});
    await secondLoad;

    expect(get).toHaveBeenCalledTimes(1);
    expect(secondVm.error).toBeNull();
    expect(secondVm.isLoading).toBe(false);

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

describe("inspector tab", () => {
  it("keeps the chosen tab while it applies to the selected node", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");

    vm.setInspectorTab("content");

    expect(vm.inspectorTab).toBe("content");
  });

  it("re-points to the first applicable tab when the new node has no such tab", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");
    vm.setInspectorTab("content");

    const spacerId = vm.addNode("spacer", "root");
    vm.selectNode(spacerId!);

    expect(vm.inspectorTab).toBe("layout");
  });

  it("is null when nothing is selected", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.inspectorTab).toBeNull();
  });
});

// =============================================================
// AI FAB apply/revert (P8 §2, §3.3) — `applyExternalTreeOp`/
// `applyExternalConfig` are the client-side landing spot for an approved
// `action_paywall_editTree` op (via the RoviProvider bridge, see
// ai-bridge.test.tsx) or an imported/generated tree. `configBeforeAiApply`
// is a ONE-SHOT pre-apply snapshot: `revertAiChange` consumes it, and any
// manual tree edit invalidates it before it's ever used.
// =============================================================
describe("AI apply/revert (configBeforeAiApply)", () => {
  it("applyExternalTreeOp applies the op, snapshots the pre-apply config, and revertAiChange restores it byte-equal", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");

    const before = vm.config;
    const beforeJson = JSON.stringify(before);

    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp1", size: 16 },
    };
    vm.applyExternalTreeOp(op);

    expect(vm.config.root.children.some((c) => c.id === "sp1")).toBe(true);
    expect(vm.configBeforeAiApply).not.toBeNull();
    expect(JSON.stringify(vm.configBeforeAiApply)).toBe(beforeJson);
    // Deselects rather than trying to resolve the touched node — an
    // insert/replace/remove isn't always "select the one thing that changed".
    expect(vm.selectedNodeId).toBeNull();

    vm.revertAiChange();

    expect(JSON.stringify(vm.config)).toBe(beforeJson);
    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("applyExternalTreeOp propagates TreeOpError and leaves config/snapshot untouched on an invalid op", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const before = vm.config;

    const badOp: PaywallTreeOp = { kind: "remove", nodeId: "does-not-exist" };

    expect(() => vm.applyExternalTreeOp(badOp)).toThrow(TreeOpError);
    expect(vm.config).toBe(before);
    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("applyExternalConfig wholesale-assigns config, snapshots the previous one, and resets locale state (applyTemplate semantics)", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");
    const before = vm.config;
    const beforeJson = JSON.stringify(before);

    const generated: BuilderConfig = emptyBuilderConfig("fr");
    generated.root.children.push({ type: "text", id: "g1", key: "g1_key", role: "title" });
    generated.localizations.fr!.g1_key = "Bonjour";

    vm.applyExternalConfig(generated);

    // Not `.toBe(generated)`: `@state config` is backed by a Vue `ref`,
    // which auto-wraps an assigned object in a reactive proxy — `vm.config`
    // is never `===` the plain object you assigned, on this VM or any
    // other `@state` field. Structural equality is the only meaningful
    // check (matches this file's existing `before`/`beforeJson` idiom).
    expect(JSON.stringify(vm.config)).toBe(JSON.stringify(generated));
    expect(vm.locales).toEqual(["fr"]);
    expect(vm.defaultLocale).toBe("fr");
    expect(vm.editLocale).toBe("fr"); // "en" no longer exists in the new locale set
    expect(vm.selectedNodeId).toBeNull();
    expect(JSON.stringify(vm.configBeforeAiApply)).toBe(beforeJson);

    vm.revertAiChange();

    expect(JSON.stringify(vm.config)).toBe(beforeJson);
    expect(vm.configBeforeAiApply).toBeNull();
    // Locale state must be re-derived from the RESTORED (single-locale
    // "en") config, not left describing the "fr" config the apply had
    // just replaced it with — otherwise the locale picker hides "en" and
    // a stale editLocale="fr" could go on writing a table that doesn't
    // belong to the restored config.
    expect(vm.locales).toEqual(["en"]);
    expect(vm.defaultLocale).toBe("en");
    expect(vm.editLocale).toBe("en");
  });

  it("applyExternalTreeOp with a setLocalizations op for a brand-new locale updates vm.locales", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    expect(vm.locales).toEqual(["en"]);

    vm.applyExternalTreeOp({
      kind: "setLocalizations",
      locale: "fr",
      entries: { t1_key: "Bonjour" },
    });

    expect(vm.config.localizations.fr).toEqual({ t1_key: "Bonjour" });
    expect(vm.locales).toEqual(["en", "fr"]);
    // Neither the default locale nor the author's current edit locale
    // change just because a new table was introduced.
    expect(vm.defaultLocale).toBe("en");
    expect(vm.editLocale).toBe("en");
  });

  it("revertAiChange is a one-shot no-op once there is nothing left to revert", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    vm.revertAiChange(); // nothing pending — no-op, no throw
    expect(vm.configBeforeAiApply).toBeNull();

    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp2", size: 8 },
    });
    vm.revertAiChange();
    const afterFirstRevert = vm.config;

    vm.revertAiChange(); // second click: nothing left to revert to
    expect(vm.config).toBe(afterFirstRevert);
    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("updateNode clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp3", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.updateNode("t1", { role: "subtitle" });

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("addNode clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp4", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.addNode("spacer", "root");

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("moveNode clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const extraId = vm.addNode("spacer", "root")!;
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp5", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.moveNode(extraId, -1);

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("moveNodeTo clears a pending AI snapshot on a legal move", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const groupId = vm.addNode("stack", "root")!;
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp8", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.moveNodeTo("t1", groupId, 0);

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("moveNodeTo does NOT clear a pending AI snapshot when the move is illegal", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp9", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    // "t1" is not a container — illegal target, per tree-ops.
    vm.moveNodeTo("root", "t1", 0);

    expect(vm.configBeforeAiApply).not.toBeNull();
  });

  it("removeNode clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    const extraId = vm.addNode("spacer", "root")!;
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp6", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.removeNode(extraId);

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("applyTemplate also clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp7", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.applyTemplate("hero");

    expect(vm.configBeforeAiApply).toBeNull();
  });

  // Review-fix (IMPORTANT 1): a locale edit is exactly as "manual" as a
  // tree edit — without clearing the snapshot here, Revert after
  // AI-apply -> setLocaleText would restore a config from BEFORE the
  // locale rename the author made ON PURPOSE in between, silently
  // discarding it. Pins the closure this finding described.
  it("setLocaleText clears a pending AI snapshot (an AI-apply -> setLocaleText sequence makes Revert impossible)", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp8", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.setLocaleText("t1_key", "en", "Updated by hand");

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("addLocale clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp9", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.addLocale("tr");

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("removeLocale clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp10", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.removeLocale("tr");

    expect(vm.configBeforeAiApply).toBeNull();
  });

  it("setDefaultLocale clears a pending AI snapshot", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("tr");
    vm.applyExternalTreeOp({
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp11", size: 8 },
    });
    expect(vm.configBeforeAiApply).not.toBeNull();

    vm.setDefaultLocale("tr");

    expect(vm.configBeforeAiApply).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-translate apply (ROADMAP §3). The translations arrive from the API as
// plain entries; the VM merges them through the SAME `setLocalizations` op
// the copilot's dry-run path uses.
//
// `setLocalizations` merges TABLE-level (other keys in the locale survive),
// but WITHIN a key the entries win — so a hand-written edit is only safe
// from a translate run if the run cannot see it in the first place. The
// reachable case is a race: the matrix's cell inputs stay enabled while a
// column translates (Finding 1's fix does not touch this), so an author can
// type into `es:title_1` while that exact key is in flight. `applyTranslations`
// protects that case via `beginTranslateRequest`, which snapshots what each
// requested key's value was the moment the request went out; a key whose
// live value has since moved is dropped from the merge rather than
// overwritten. A key nobody snapshotted (no `beginTranslateRequest` call, or
// a key that wasn't in it) is written unconditionally — that's the ordinary
// happy path, not a race, and it's how every other test below still calls
// `applyTranslations` directly with no snapshot at all.
// ---------------------------------------------------------------------------
describe("PaywallBuilderViewModel — applyTranslations", () => {
  async function vmWithLocales() {
    const get = vi.fn().mockResolvedValue(fakeDetail({ offeringPackageIds: [] }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.addLocale("es");
    return vm;
  }

  it("merges into the target locale and leaves other locales untouched", async () => {
    const vm = await vmWithLocales();
    const englishBefore = { ...vm.config.localizations[vm.defaultLocale] };

    vm.applyTranslations("es", { title_1: "Hazte Pro" });

    expect(vm.config.localizations.es).toMatchObject({ title_1: "Hazte Pro" });
    expect(vm.config.localizations[vm.defaultLocale]).toEqual(englishBefore);
  });

  it("does not overwrite a value the author hand-edits WHILE that same key is in flight", async () => {
    const vm = await vmWithLocales();

    // The modal calls this right before firing the translate request, with
    // the keys it's about to ask for — snapshotting what they held at that
    // moment (here, both still blank).
    vm.beginTranslateRequest("es", ["title_1", "other_1"]);
    // The author types into the SAME cell the in-flight request also
    // covers, before the response lands.
    vm.setLocaleText("title_1", "es", "Mi propio texto");

    // The response comes back naming BOTH keys — proving the merge
    // discriminates per key rather than dropping (or keeping) the whole
    // run: `other_1` was never hand-edited and must still apply.
    vm.applyTranslations("es", { title_1: "Hazte Pro", other_1: "Otro" });

    expect(vm.config.localizations.es!.title_1).toBe("Mi propio texto");
    expect(vm.config.localizations.es!.other_1).toBe("Otro");
  });

  it("applies a key unconditionally when it was never snapshotted — the ordinary happy path", async () => {
    const vm = await vmWithLocales();

    // No `beginTranslateRequest` call at all — every other test in this
    // file calls `applyTranslations` this way, and must keep working.
    vm.applyTranslations("es", { title_1: "Hazte Pro" });

    expect(vm.config.localizations.es!.title_1).toBe("Hazte Pro");
  });

  it("marks every applied cell machine-translated, scoped to its locale", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("es", { title_1: "Hazte Pro" });

    expect(vm.machineTranslated.has("es:title_1")).toBe(true);
    expect(vm.machineTranslated.has("en:title_1")).toBe(false);
  });

  it("clears the mark when the author edits that cell", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("es", { title_1: "Hazte Pro" });
    vm.setLocaleText("title_1", "es", "Hazte Pro (revisado)");

    expect(vm.machineTranslated.has("es:title_1")).toBe(false);
  });

  it("clears only the edited cell's mark", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("es", { title_1: "Uno", other_1: "Otro" });
    vm.setLocaleText("title_1", "es", "Uno revisado");

    expect(vm.machineTranslated.has("es:title_1")).toBe(false);
    expect(vm.machineTranslated.has("es:other_1")).toBe(true);
  });

  it("keeps the marking OUT of BuilderConfig — the config is the SDK wire format", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("es", { title_1: "Hazte Pro" });

    expect(JSON.stringify(vm.config)).not.toContain("machineTranslated");
  });

  it("one revert restores the whole pre-translation config", async () => {
    const vm = await vmWithLocales();
    const before = JSON.stringify(vm.config);

    vm.applyTranslations("es", { title_1: "Uno", other_1: "Otro" });
    expect(JSON.stringify(vm.config)).not.toBe(before);

    vm.revertAiChange();
    expect(JSON.stringify(vm.config)).toBe(before);
  });

  it("a revert also drops the marks, so no cell is marked machine-written after it", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("es", { title_1: "Uno" });
    vm.revertAiChange();

    expect(vm.machineTranslated.size).toBe(0);
  });

  it("reverting run 2 keeps run 1's translations AND run 1's marks — the marks are snapshotted beside the config", async () => {
    // configBeforeAiApply is overwritten by every run: after run 2 it holds
    // the config as it stood after run 1 (run 1's translations included).
    // The mark set must be snapshotted the SAME way, or a revert restores
    // text that machineTranslated no longer says is unreviewed.
    const vm = await vmWithLocales();

    vm.applyTranslations("es", { title_1: "Uno" });
    vm.applyTranslations("es", { other_1: "Otro" });
    vm.revertAiChange();

    // Run 1's translation is still in the config (revert only undoes run 2)...
    expect(vm.config.localizations.es!.title_1).toBe("Uno");
    expect(vm.config.localizations.es).not.toHaveProperty("other_1");
    // ...and must still carry run 1's "unreviewed machine output" mark.
    expect(vm.machineTranslated.has("es:title_1")).toBe(true);
    expect(vm.machineTranslated.has("es:other_1")).toBe(false);
  });

  it("a manual edit after applying clears the revert snapshot, as it does for every AI path", async () => {
    const vm = await vmWithLocales();
    const afterApply = (() => {
      vm.applyTranslations("es", { title_1: "Uno" });
      return JSON.stringify(vm.config);
    })();

    vm.setLocaleText("title_1", "es", "Uno revisado");
    vm.revertAiChange();

    // Revert must be a no-op now: it cannot resurrect a config the author
    // has since hand-edited.
    expect(JSON.stringify(vm.config)).not.toBe(afterApply);
    expect(vm.config.localizations.es!.title_1).toBe("Uno revisado");
  });

  it("is a no-op for an empty entries object — no snapshot, nothing to undo", async () => {
    const vm = await vmWithLocales();
    const before = JSON.stringify(vm.config);

    vm.applyTranslations("es", {});

    expect(JSON.stringify(vm.config)).toBe(before);
    expect(vm.machineTranslated.size).toBe(0);
  });

  it("creates a locale table that did not exist, and surfaces it in vm.locales", async () => {
    const vm = await vmWithLocales();
    vm.applyTranslations("pt-br", { title_1: "Torne-se Pro" });

    expect(vm.locales).toContain("pt-br");
    expect(vm.config.localizations["pt-br"]).toMatchObject({ title_1: "Torne-se Pro" });
  });
});
