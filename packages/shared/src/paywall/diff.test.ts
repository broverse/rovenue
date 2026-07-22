import { describe, expect, it } from "vitest";
import { diffBuilderConfigs } from "./diff";
import type { BuilderConfig } from "./schema";

function base(): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title: "Hello", cta: "Buy" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      spacing: 8,
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        {
          type: "packageList",
          id: "pl",
          packageIds: ["monthly", "annual"],
          defaultSelected: "monthly",
          cellLayout: "row",
        },
        { type: "purchaseButton", id: "pb", labelKey: "cta" },
      ],
    },
  };
}

describe("diffBuilderConfigs", () => {
  it("returns nothing for identical configs", () => {
    expect(diffBuilderConfigs(base(), base())).toEqual([]);
  });

  it("reports a changed scalar node prop", () => {
    const to = base();
    (to.root.children[1] as { defaultSelected?: string }).defaultSelected = "annual";

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toEqual([
      {
        kind: "changed",
        scope: "node",
        nodeId: "pl",
        nodeType: "packageList",
        field: "defaultSelected",
        from: '"monthly"',
        to: '"annual"',
      },
    ]);
  });

  it("reports an added node", () => {
    const to = base();
    to.root.children.push({ type: "spacer", id: "sp", size: 12 });

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "sp",
      nodeType: "spacer",
      field: "node",
      from: null,
      to: "spacer",
    });
  });

  it("reports a removed node", () => {
    const from = base();
    const to = base();
    to.root.children = to.root.children.filter((n) => n.id !== "pb");

    const entries = diffBuilderConfigs(from, to);
    expect(entries).toContainEqual({
      kind: "removed",
      scope: "node",
      nodeId: "pb",
      nodeType: "purchaseButton",
      field: "node",
      from: "purchaseButton",
      to: null,
    });
  });

  it("reports array element changes with index paths", () => {
    const to = base();
    (to.root.children[1] as { packageIds: string[] }).packageIds = ["monthly", "weekly"];

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toContainEqual({
      kind: "changed",
      scope: "node",
      nodeId: "pl",
      nodeType: "packageList",
      field: "packageIds[1]",
      from: '"annual"',
      to: '"weekly"',
    });
  });

  it("reports localization changes, additions and removals", () => {
    const to = base();
    to.localizations.en!.title = "Hi";
    to.localizations.en!.extra = "New";
    delete to.localizations.en!.cta;

    const entries = diffBuilderConfigs(base(), to).filter((e) => e.scope === "localization");
    expect(entries).toEqual([
      { kind: "changed", scope: "localization", nodeId: null, nodeType: null, field: "en.title", from: '"Hello"', to: '"Hi"' },
      { kind: "removed", scope: "localization", nodeId: null, nodeType: null, field: "en.cta", from: '"Buy"', to: null },
      { kind: "added", scope: "localization", nodeId: null, nodeType: null, field: "en.extra", from: null, to: '"New"' },
    ]);
  });

  it("reports config-level changes", () => {
    const to = base();
    to.defaultLocale = "de";
    to.background = { light: "#fff", dark: "#000" };

    const entries = diffBuilderConfigs(base(), to).filter((e) => e.scope === "config");
    expect(entries).toContainEqual({
      kind: "changed",
      scope: "config",
      nodeId: null,
      nodeType: null,
      field: "defaultLocale",
      from: '"en"',
      to: '"de"',
    });
    expect(entries).toContainEqual({
      kind: "added",
      scope: "config",
      nodeId: null,
      nodeType: null,
      field: "background.light",
      from: null,
      to: '"#fff"',
    });
  });

  it("descends into fallback and cellTemplate subtrees as nodes", () => {
    const from = base();
    const to = base();
    (to.root.children[1] as { cellTemplate?: unknown }).cellTemplate = {
      type: "text",
      id: "cell",
      key: "title",
      role: "body",
    };

    const entries = diffBuilderConfigs(from, to);
    expect(entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "cell",
      nodeType: "text",
      field: "node",
      from: null,
      to: "text",
    });
  });

  it("treats a null side as everything added or removed", () => {
    expect(diffBuilderConfigs(null, null)).toEqual([]);
    const added = diffBuilderConfigs(null, base());
    expect(added.some((e) => e.kind === "added" && e.nodeId === "root")).toBe(true);
    const removed = diffBuilderConfigs(base(), null);
    expect(removed.every((e) => e.kind === "removed")).toBe(true);
  });
});
