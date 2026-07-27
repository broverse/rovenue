import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { OverridesSection } from "./overrides";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import {
  ICON_NAMES,
  emptyBuilderConfig,
  type BuilderConfig,
  type DividerNode,
  type IconNode,
} from "@rovenue/shared/paywall";

// =============================================================
// OverridesSection — divider.color / divider.thickness / icon.name /
// icon.color. OVERRIDABLE_PROP_KEYS lists all four as overridable, and
// OverridesSection renders the section (and a labelled row per key) for
// any node type with a non-empty entry — but OverridePropField's switch
// had no case for any of the four, so every row silently rendered
// nothing (`default: return null`). An author who added an "Intro
// eligible" override on a divider or icon got a labelled row with no
// control in it at all. These pin real, interactive controls for all
// four, and would fail against the pre-fix switch (every assertion
// below either finds zero elements or throws on a `getAllBy*` with no
// matches).
// =============================================================

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({
    type: "divider",
    id: "d1",
    overrides: [{ when: { kind: "introEligible" }, props: { color: { light: "#123456" }, thickness: 3 } }],
  } as DividerNode);
  config.root.children.push({
    type: "icon",
    id: "i1",
    name: "check",
    overrides: [{ when: { kind: "introEligible" }, props: { name: "star", color: { light: "#abcdef" } } }],
  } as IconNode);
  return config;
}

function fakeDetail(): PaywallBuilderDetailDto {
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
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

/** Looks up the live node by id on every render, so it tracks `vm.config` edits. */
const Harness = component(({ id }: { id: string }) => {
  const vm = useService(PaywallBuilderViewModel);
  const node = findNode(vm.config.root, id);
  if (!node) return null;
  return <OverridesSection node={node} />;
});

/** Mounts OverridesSection inside real DI, loaded from a fake config, and hands back the live VM. */
async function renderHarness(id: string) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail());

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <ServiceProvider
      provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
      props={{ projectId: "p_1", paywallId: "pw_1" }}
    >
      <Probe />
      <Harness id={id} />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  // The Overrides section is a collapsible <Section>, closed by default
  // (OverridesSection doesn't pass defaultOpen) — its content, including
  // every per-key field, isn't even mounted until the header is opened.
  fireEvent.click(screen.getByRole("button", { name: /overrides/i }));

  return { vm, ...utils };
}

describe("OverridesSection — divider override fields", () => {
  it("renders a real thickness input and color inputs, not a silent no-op", async () => {
    const { container } = await renderHarness("d1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(1);
    expect((numberInputs[0] as HTMLInputElement).value).toBe("3");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited thickness back onto the override's props", async () => {
    const { vm, container } = await renderHarness("d1");
    const thicknessInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(thicknessInput, { target: { value: "5" } });
    const node = findNode(vm.config.root, "d1") as DividerNode;
    expect(node.overrides?.[0]?.props.thickness).toBe(5);
  });
});

describe("OverridesSection — icon override fields", () => {
  it("renders an ICON_NAMES-driven picker (not free text) plus color inputs", async () => {
    const { container } = await renderHarness("i1");
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    const optionValues = Array.from(select!.querySelectorAll("option")).map((o) => o.value);
    expect(optionValues).toEqual([...ICON_NAMES]);
    expect(select!.value).toBe("star");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes a picked icon name back onto the override's props", async () => {
    const { vm, container } = await renderHarness("i1");
    const select = container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "check" } });
    const node = findNode(vm.config.root, "i1") as IconNode;
    expect(node.overrides?.[0]?.props.name).toBe("check");
  });
});
