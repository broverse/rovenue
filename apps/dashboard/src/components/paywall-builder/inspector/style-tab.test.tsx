import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { StyleTab } from "./style-tab";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import { emptyBuilderConfig, type BuilderConfig, type DividerNode, type IconNode } from "@rovenue/shared/paywall";

// =============================================================
// StyleTab — divider/icon color field. Both types carry an optional
// `color: ThemeColor` the schema, OVERRIDABLE_PROP_KEYS, and the web +
// SwiftUI renderers already treat as real, but no tab exposed it. These
// pin the field's reachability + wiring so a future refactor of the
// Style tab can't silently drop it again.
// =============================================================

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({ type: "divider", id: "d1" } as DividerNode);
  config.root.children.push({ type: "icon", id: "i1", name: "check" } as IconNode);
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
  return <StyleTab node={node} />;
});

/** Mounts StyleTab inside real DI, loaded from a fake config, and hands back the live VM. */
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

  return { vm, ...utils };
}

describe("StyleTab — divider color", () => {
  it("renders a color field (light + dark) for a divider node", async () => {
    await renderHarness("d1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes a light color back onto the divider node", async () => {
    const { vm } = await renderHarness("d1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    // fireEvent.change (one shot) rather than userEvent.type (per keystroke):
    // ColorSwatchInput commits and re-syncs its local text from the prop on
    // every VALID partial hex (a 3-digit shorthand mid-typing counts), so
    // typing character-by-character races its own controlled-value effect.
    // That's a pre-existing property of the shared widget, not something
    // this fix touches — one-shot input is what actually isolates the
    // behaviour under test (does onChange reach the divider node's color).
    fireEvent.change(light!, { target: { value: "#112233" } });
    const node = findNode(vm.config.root, "d1") as DividerNode;
    expect(node.color?.light).toBe("#112233");
  });
});

describe("StyleTab — icon color", () => {
  it("renders a color field (light + dark) for an icon node", async () => {
    await renderHarness("i1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes a light color back onto the icon node", async () => {
    const { vm } = await renderHarness("i1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#445566" } });
    const node = findNode(vm.config.root, "i1") as IconNode;
    expect(node.color?.light).toBe("#445566");
  });
});
