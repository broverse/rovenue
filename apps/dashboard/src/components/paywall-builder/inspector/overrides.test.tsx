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
  SOCIAL_PROOF_MAX_RATING,
  emptyBuilderConfig,
  type BuilderConfig,
  type CarouselNode,
  type CountdownNode,
  type DividerNode,
  type FeatureListNode,
  type IconNode,
  type SocialProofNode,
  type StickyFooterNode,
  type TimelineNode,
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
  config.root.children.push({
    type: "featureList",
    id: "fl1",
    rows: [{ labelKey: "k_fl" }],
    overrides: [{ when: { kind: "introEligible" }, props: { iconColor: { light: "#111111" } } }],
  } as FeatureListNode);
  config.root.children.push({
    type: "timeline",
    id: "tl1",
    rows: [{ labelKey: "k_tl" }],
    overrides: [{ when: { kind: "introEligible" }, props: { connectorColor: { light: "#222222" } } }],
  } as TimelineNode);
  config.root.children.push({
    type: "socialProof",
    id: "sp1",
    labelKey: "k_sp",
    overrides: [
      { when: { kind: "introEligible" }, props: { rating: 4, starColor: { light: "#333333" } } },
    ],
  } as SocialProofNode);
  config.root.children.push({
    type: "stickyFooter",
    id: "sf1",
    children: [],
    overrides: [{ when: { kind: "introEligible" }, props: { background: { light: "#444444" } } }],
  } as StickyFooterNode);
  config.root.children.push({
    type: "countdown",
    id: "cd1",
    durationSeconds: 900,
    overrides: [{ when: { kind: "introEligible" }, props: { color: { light: "#555555" } } }],
  } as CountdownNode);
  config.root.children.push({
    type: "carousel",
    id: "car1",
    children: [],
    overrides: [{ when: { kind: "introEligible" }, props: { indicatorColor: { light: "#666666" } } }],
  } as CarouselNode);
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

// =============================================================
// Wave B — featureList.iconColor / timeline.connectorColor /
// socialProof.rating / socialProof.starColor. These are the four keys
// Task 1 declared in OVERRIDABLE_PROP_KEYS for the row-carrying node
// types; the same wave A defect (a declared override key with no
// rendered field) applies to any of the four left unwired. Verified to
// fail against the pre-fix switch (see task-3-report.md).
// =============================================================

describe("OverridesSection — featureList override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("fl1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited icon color back onto the override's props", async () => {
    const { vm } = await renderHarness("fl1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#123456" } });
    const node = findNode(vm.config.root, "fl1") as FeatureListNode;
    expect(node.overrides?.[0]?.props.iconColor).toEqual({ light: "#123456" });
  });
});

describe("OverridesSection — timeline override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("tl1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited connector color back onto the override's props", async () => {
    const { vm } = await renderHarness("tl1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#234567" } });
    const node = findNode(vm.config.root, "tl1") as TimelineNode;
    expect(node.overrides?.[0]?.props.connectorColor).toEqual({ light: "#234567" });
  });
});

describe("OverridesSection — socialProof override fields", () => {
  it("renders a real rating number input and a color input, not a silent no-op", async () => {
    const { container } = await renderHarness("sp1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(1);
    expect((numberInputs[0] as HTMLInputElement).value).toBe("4");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited rating back onto the override's props, clamped to the max", async () => {
    const { vm, container } = await renderHarness("sp1");
    const ratingInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(ratingInput, { target: { value: "9" } });
    const node = findNode(vm.config.root, "sp1") as SocialProofNode;
    expect(node.overrides?.[0]?.props.rating).toBe(SOCIAL_PROOF_MAX_RATING);
  });

  it("writes an edited star color back onto the override's props", async () => {
    const { vm } = await renderHarness("sp1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#abcdef" } });
    const node = findNode(vm.config.root, "sp1") as SocialProofNode;
    expect(node.overrides?.[0]?.props.starColor).toEqual({ light: "#abcdef" });
  });
});

// =============================================================
// Wave C — stickyFooter.background / countdown.color. Same defect class:
// Task 1 declared both keys in OVERRIDABLE_PROP_KEYS, and without a case
// in OverridePropField's switch these would fall through to the removed
// `default: return null` (now a compile-time exhaustiveness check instead).
// =============================================================

describe("OverridesSection — stickyFooter override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("sf1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited background back onto the override's props", async () => {
    const { vm } = await renderHarness("sf1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#123456" } });
    const node = findNode(vm.config.root, "sf1") as StickyFooterNode;
    expect(node.overrides?.[0]?.props.background).toEqual({ light: "#123456" });
  });
});

describe("OverridesSection — countdown override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("cd1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited color back onto the override's props", async () => {
    const { vm } = await renderHarness("cd1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#654321" } });
    const node = findNode(vm.config.root, "cd1") as CountdownNode;
    expect(node.overrides?.[0]?.props.color).toEqual({ light: "#654321" });
  });
});

// =============================================================
// Wave D1 — carousel.indicatorColor. Same defect class: Task 1 declared
// the key in OVERRIDABLE_PROP_KEYS.carousel, and without a case in
// OverridePropField's switch this would fall through to the removed
// `default: return null` (now a compile-time exhaustiveness check
// instead). Note: `indicatorColor` renders via `ThemeColorField`, whose
// `Field` label is NOT wired via `htmlFor`/an id on the input (it's a
// sibling label, not a wrapping one), so `getByLabelText` cannot find
// it — this suite uses the same `getAllByPlaceholderText("#0F172A")`
// pattern the divider/icon/stickyFooter/countdown color suites above use,
// since that is what the widget actually exposes to a test.
// =============================================================
describe("OverridesSection — carousel override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("car1");
    expect(screen.getAllByPlaceholderText("#0F172A")).toHaveLength(2);
  });

  it("writes an edited indicator color back onto the override's props", async () => {
    const { vm } = await renderHarness("car1");
    const [light] = screen.getAllByPlaceholderText("#0F172A");
    fireEvent.change(light!, { target: { value: "#777777" } });
    const node = findNode(vm.config.root, "car1") as CarouselNode;
    expect(node.overrides?.[0]?.props.indicatorColor).toEqual({ light: "#777777" });
  });
});
