import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { UNSET_HEX_PLACEHOLDER } from "./fields";
import { StyleTab } from "./style-tab";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import {
  emptyBuilderConfig,
  type BuilderConfig,
  type ButtonNode,
  type DividerNode,
  type IconNode,
  type ImageNode,
  type PurchaseButtonNode,
  type StackNode,
  type TextNode,
} from "@rovenue/shared/paywall";

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
  config.root.children.push({ type: "text", id: "t1", key: "k_t1", role: "body" } as TextNode);
  config.root.children.push({
    type: "image",
    id: "img1",
    url: { light: "https://cdn.example.com/img.png" },
  } as ImageNode);
  config.root.children.push({
    type: "button",
    id: "b1",
    labelKey: "k_b1",
    style: "primary",
    action: { kind: "close" },
  } as ButtonNode);
  config.root.children.push({
    type: "purchaseButton",
    id: "pb1",
    labelKey: "k_pb1",
  } as PurchaseButtonNode);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes a light color back onto the divider node", async () => {
    const { vm } = await renderHarness("d1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes a light color back onto the icon node", async () => {
    const { vm } = await renderHarness("i1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(light!, { target: { value: "#445566" } });
    const node = findNode(vm.config.root, "i1") as IconNode;
    expect(node.color?.light).toBe("#445566");
  });
});

// =============================================================
// Node style pass — border/background/labelColor/cornerRadius. Task 1
// (schema.ts) added these props to stack/text/image/button/purchaseButton;
// these pin that the Style tab actually surfaces controls for every one of
// them, per the plan's matrix, and that each control writes onto the right
// node prop.
// =============================================================

describe("StyleTab — stack border", () => {
  it("renders a border width input and color field for the root stack node", async () => {
    await renderHarness("root");
    const numberInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    // Corner radius (pre-existing) + border width (new).
    expect(numberInputs.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER).length).toBeGreaterThanOrEqual(4);
  });

  it("writes a complete border object onto the stack node", async () => {
    const { vm, container } = await renderHarness("root");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const borderWidthInput = numberInputs[numberInputs.length - 1]!;
    fireEvent.change(borderWidthInput, { target: { value: "2" } });
    const node = findNode(vm.config.root, "root") as StackNode;
    expect(node.border?.width).toBe(2);
    expect(node.border?.color).toBeDefined();
  });
});

describe("StyleTab — text background + corner radius", () => {
  it("renders background and corner-radius fields for a text node", async () => {
    await renderHarness("t1");
    // Existing `color` field + new `background` field = 2 pairs = 4 inputs.
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(4);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(1);
  });

  it("writes a background color onto the text node", async () => {
    const { vm } = await renderHarness("t1");
    const colorInputs = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    const [, , backgroundLight] = colorInputs;
    fireEvent.change(backgroundLight!, { target: { value: "#abcdef" } });
    const node = findNode(vm.config.root, "t1") as TextNode;
    expect(node.background?.light).toBe("#abcdef");
  });

  it("writes a corner radius onto the text node", async () => {
    const { vm, container } = await renderHarness("t1");
    const radiusInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(radiusInput, { target: { value: "8" } });
    const node = findNode(vm.config.root, "t1") as TextNode;
    expect(node.cornerRadius).toBe(8);
  });
});

describe("StyleTab — image border", () => {
  it("renders a border width input and color field for an image node", async () => {
    await renderHarness("img1");
    // Existing corner-radius NumberField + new border-width NumberField.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes a complete border object onto the image node", async () => {
    const { vm, container } = await renderHarness("img1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const borderWidthInput = numberInputs[numberInputs.length - 1]!;
    fireEvent.change(borderWidthInput, { target: { value: "3" } });
    const node = findNode(vm.config.root, "img1") as ImageNode;
    expect(node.border?.width).toBe(3);
    expect(node.border?.color).toBeDefined();
  });
});

describe("StyleTab — button background, label color, border, corner radius", () => {
  it("renders background, label color, border, and corner-radius controls", async () => {
    await renderHarness("b1");
    // background + labelColor + border-color = 3 pairs = 6 inputs.
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(6);
    // border width + corner radius = 2 number inputs.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
  });

  it("writes a background color onto the button node", async () => {
    const { vm } = await renderHarness("b1");
    const [bgLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(bgLight!, { target: { value: "#111111" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.background?.light).toBe("#111111");
  });

  it("writes a label color onto the button node", async () => {
    const { vm } = await renderHarness("b1");
    const [, , labelLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(labelLight!, { target: { value: "#222222" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.labelColor?.light).toBe("#222222");
  });

  it("writes a complete border object onto the button node", async () => {
    const { vm, container } = await renderHarness("b1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const borderWidthInput = numberInputs[0]!;
    fireEvent.change(borderWidthInput, { target: { value: "1" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.border?.width).toBe(1);
    expect(node.border?.color).toBeDefined();
  });

  it("writes a corner radius onto the button node", async () => {
    const { vm, container } = await renderHarness("b1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const radiusInput = numberInputs[numberInputs.length - 1]!;
    fireEvent.change(radiusInput, { target: { value: "12" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.cornerRadius).toBe(12);
  });
});

describe("StyleTab — purchaseButton background, label color, border, corner radius", () => {
  it("renders background, label color, border, and corner-radius controls", async () => {
    await renderHarness("pb1");
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(6);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
  });

  it("writes a background color onto the purchaseButton node", async () => {
    const { vm } = await renderHarness("pb1");
    const [bgLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(bgLight!, { target: { value: "#333333" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.background?.light).toBe("#333333");
  });

  it("writes a label color onto the purchaseButton node", async () => {
    const { vm } = await renderHarness("pb1");
    const [, , labelLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(labelLight!, { target: { value: "#444444" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.labelColor?.light).toBe("#444444");
  });

  it("writes a complete border object onto the purchaseButton node", async () => {
    const { vm, container } = await renderHarness("pb1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const borderWidthInput = numberInputs[0]!;
    fireEvent.change(borderWidthInput, { target: { value: "2" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.border?.width).toBe(2);
    expect(node.border?.color).toBeDefined();
  });

  it("writes a corner radius onto the purchaseButton node", async () => {
    const { vm, container } = await renderHarness("pb1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const radiusInput = numberInputs[numberInputs.length - 1]!;
    fireEvent.change(radiusInput, { target: { value: "6" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.cornerRadius).toBe(6);
  });
});
