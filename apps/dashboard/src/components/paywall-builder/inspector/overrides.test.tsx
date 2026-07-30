import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { server } from "../../../../tests/msw/server";
import { UNSET_HEX_PLACEHOLDER } from "./fields";
import { OverridesSection } from "./overrides";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import {
  ICON_NAMES,
  SOCIAL_PROOF_MAX_RATING,
  emptyBuilderConfig,
  type BuilderConfig,
  type ButtonNode,
  type CarouselNode,
  type CountdownNode,
  type DividerNode,
  type FeatureListNode,
  type IconNode,
  type ImageNode,
  type LottieNode,
  type PurchaseButtonNode,
  type SocialProofNode,
  type StackNode,
  type StickyFooterNode,
  type TextNode,
  type TimelineNode,
  type VideoNode,
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
  config.root.children.push({
    type: "video",
    id: "v1",
    url: { light: "https://cdn.example.com/video.mp4" },
    overrides: [
      {
        when: { kind: "introEligible" },
        props: {
          url: { light: "https://cdn.example.com/alt.mp4" },
          posterUrl: { light: "https://cdn.example.com/poster.png" },
        },
      },
    ],
  } as VideoNode);
  config.root.children.push({
    type: "lottie",
    id: "lt1",
    url: { light: "https://cdn.example.com/anim.json" },
    overrides: [
      {
        when: { kind: "introEligible" },
        props: { url: { light: "https://cdn.example.com/alt-anim.json" } },
      },
    ],
  } as LottieNode);
  // Node style pass — border/background/labelColor/cornerRadius overrides,
  // reusing `root` itself for the stack case (it's already a StackNode).
  config.root.overrides = [
    { when: { kind: "introEligible" }, props: { border: { width: 2, color: { light: "#0f1720" } } } },
  ];
  config.root.children.push({
    type: "text",
    id: "t1",
    key: "k_t1",
    role: "body",
    overrides: [
      {
        when: { kind: "introEligible" },
        props: { background: { light: "#101010" }, cornerRadius: 4 },
      },
    ],
  } as TextNode);
  config.root.children.push({
    type: "image",
    id: "img1",
    url: { light: "https://cdn.example.com/img.png" },
    overrides: [
      { when: { kind: "introEligible" }, props: { border: { width: 1, color: { light: "#202020" } } } },
    ],
  } as ImageNode);
  config.root.children.push({
    type: "button",
    id: "b1",
    labelKey: "k_b1",
    style: "primary",
    action: { kind: "close" },
    overrides: [
      {
        when: { kind: "introEligible" },
        props: {
          background: { light: "#303030" },
          labelColor: { light: "#ffffff" },
          border: { width: 1, color: { light: "#404040" } },
          cornerRadius: 6,
        },
      },
    ],
  } as ButtonNode);
  config.root.children.push({
    type: "purchaseButton",
    id: "pb1",
    labelKey: "k_pb1",
    overrides: [
      {
        when: { kind: "introEligible" },
        props: {
          background: { light: "#505050" },
          labelColor: { light: "#eeeeee" },
          border: { width: 2, color: { light: "#606060" } },
          cornerRadius: 8,
        },
      },
    ],
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

  // `video.url`/`video.posterUrl`/`lottie.url` now render a `ThemeUrlField`
  // with `kind`+`projectId` set (asset-picker wiring, task 11), so
  // `AssetPickerDialog` — and the `useAssets` query it calls once opened —
  // needs a real `QueryClientProvider` ancestor, same as
  // `asset-library.test.tsx`'s own `wrap()` helper.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ServiceProvider
        provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
        props={{ projectId: "p_1", paywallId: "pw_1" }}
      >
        <Probe />
        <Harness id={id} />
      </ServiceProvider>
    </QueryClientProvider>,
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited icon color back onto the override's props", async () => {
    const { vm } = await renderHarness("fl1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(light!, { target: { value: "#123456" } });
    const node = findNode(vm.config.root, "fl1") as FeatureListNode;
    expect(node.overrides?.[0]?.props.iconColor).toEqual({ light: "#123456" });
  });
});

describe("OverridesSection — timeline override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("tl1");
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited connector color back onto the override's props", async () => {
    const { vm } = await renderHarness("tl1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
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
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
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
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited background back onto the override's props", async () => {
    const { vm } = await renderHarness("sf1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(light!, { target: { value: "#123456" } });
    const node = findNode(vm.config.root, "sf1") as StickyFooterNode;
    expect(node.overrides?.[0]?.props.background).toEqual({ light: "#123456" });
  });
});

describe("OverridesSection — countdown override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("cd1");
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited color back onto the override's props", async () => {
    const { vm } = await renderHarness("cd1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
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
// it — this suite uses the same `getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)`
// pattern the divider/icon/stickyFooter/countdown color suites above use,
// since that is what the widget actually exposes to a test.
// =============================================================
describe("OverridesSection — carousel override fields", () => {
  it("renders a real color input, not a silent no-op", async () => {
    await renderHarness("car1");
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited indicator color back onto the override's props", async () => {
    const { vm } = await renderHarness("car1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(light!, { target: { value: "#777777" } });
    const node = findNode(vm.config.root, "car1") as CarouselNode;
    expect(node.overrides?.[0]?.props.indicatorColor).toEqual({ light: "#777777" });
  });
});

// =============================================================
// Wave D2 — video.url / video.posterUrl / lottie.url. Same defect class
// again, this time for a `ThemeUrl` (not a `ThemeColor`): Task 1 declared
// both keys in OVERRIDABLE_PROP_KEYS.video and the one key in
// OVERRIDABLE_PROP_KEYS.lottie. Without a case in OverridePropField's
// switch these fall through to the compile-time exhaustiveness check
// instead of rendering — these pin real, interactive text inputs seeded
// with the override's own value (a ThemeColor swatch has no analogue here,
// so this locates inputs by their live text value rather than a shared
// color placeholder).
// =============================================================

/** Every non-number, non-checkbox `<input>` under `container` — the shape
 *  `ThemeUrlField` renders one of, per light/dark row. */
function textInputsIn(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll("input")).filter(
    (el) => el.type !== "number" && el.type !== "checkbox",
  ) as HTMLInputElement[];
}

describe("OverridesSection — video override fields", () => {
  it("renders real url and posterUrl inputs, not a silent no-op", async () => {
    const { container } = await renderHarness("v1");
    const values = textInputsIn(container).map((el) => el.value);
    expect(values).toContain("https://cdn.example.com/alt.mp4");
    expect(values).toContain("https://cdn.example.com/poster.png");
  });

  it("writes an edited url back onto the override's props", async () => {
    const { vm, container } = await renderHarness("v1");
    const urlInput = textInputsIn(container).find((el) => el.value === "https://cdn.example.com/alt.mp4")!;
    fireEvent.change(urlInput, { target: { value: "https://cdn.example.com/new.mp4" } });
    const node = findNode(vm.config.root, "v1") as VideoNode;
    expect(node.overrides?.[0]?.props.url).toEqual({ light: "https://cdn.example.com/new.mp4" });
  });

  it("writes an edited posterUrl back onto the override's props", async () => {
    const { vm, container } = await renderHarness("v1");
    const posterInput = textInputsIn(container).find(
      (el) => el.value === "https://cdn.example.com/poster.png",
    )!;
    fireEvent.change(posterInput, { target: { value: "https://cdn.example.com/new-poster.png" } });
    const node = findNode(vm.config.root, "v1") as VideoNode;
    expect(node.overrides?.[0]?.props.posterUrl).toEqual({ light: "https://cdn.example.com/new-poster.png" });
  });
});

// =============================================================
// Wave task-11 fix round — the picker must actually be reachable from
// the overrides panel, not just from content-tab.tsx: an author
// overriding `video.url` for an `introEligible` condition gets the
// SAME "Browse assets" affordance as the base field, scoped to the
// SAME kind (`posterUrl` browses images, `url` browses videos).
// =============================================================

function mockVideoAsset() {
  server.use(
    http.get("http://localhost:3000/dashboard/projects/p_1/assets", () =>
      HttpResponse.json({
        data: {
          assets: [
            {
              id: "vid_1",
              projectId: "p_1",
              kind: "video",
              name: "hero-video",
              contentHash: "h".repeat(64),
              contentType: "video/mp4",
              byteSize: 1024,
              width: null,
              height: null,
              sourceFormat: null,
              sourceWidth: null,
              sourceHeight: null,
              policyVersion: 0,
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
              deletedAt: null,
              url: "http://localhost:3000/cdn/p_1/vid_1.mp4",
            },
          ],
          usage: { usedBytes: 0, limitBytes: null },
        },
      }),
    ),
  );
}

describe("OverridesSection — video override fields (asset picker)", () => {
  it("fills the url override from a picked asset, scoped to kind=video", async () => {
    mockVideoAsset();
    const { vm } = await renderHarness("v1");

    const [browseUrlLight] = screen.getAllByRole("button", { name: /browse assets/i });
    fireEvent.click(browseUrlLight!);
    fireEvent.click(await screen.findByText("hero-video"));

    const node = findNode(vm.config.root, "v1") as VideoNode;
    expect(node.overrides?.[0]?.props.url).toEqual({
      light: "http://localhost:3000/cdn/p_1/vid_1.mp4",
    });
  });
});

describe("OverridesSection — lottie override fields", () => {
  it("renders a real url input, not a silent no-op", async () => {
    const { container } = await renderHarness("lt1");
    const values = textInputsIn(container).map((el) => el.value);
    expect(values).toContain("https://cdn.example.com/alt-anim.json");
  });

  it("writes an edited url back onto the override's props", async () => {
    const { vm, container } = await renderHarness("lt1");
    const urlInput = textInputsIn(container).find(
      (el) => el.value === "https://cdn.example.com/alt-anim.json",
    )!;
    fireEvent.change(urlInput, { target: { value: "https://cdn.example.com/new-anim.json" } });
    const node = findNode(vm.config.root, "lt1") as LottieNode;
    expect(node.overrides?.[0]?.props.url).toEqual({ light: "https://cdn.example.com/new-anim.json" });
  });
});

// =============================================================
// Node style pass — border/background/labelColor/cornerRadius overrides.
// Task 1 added these keys to OVERRIDABLE_PROP_KEYS for stack/text/image/
// button/purchaseButton; same defect class as every wave above applies:
// a declared override key with no case in `OverridePropField`'s switch
// falls through to the compile-time exhaustiveness check instead of
// rendering a real control.
// =============================================================

describe("OverridesSection — stack (root) border override field", () => {
  it("renders a real border width input and color inputs, not a silent no-op", async () => {
    const { container } = await renderHarness("root");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    // spacing + cornerRadius + border width.
    expect(numberInputs.length).toBe(3);
    const borderWidthInput = numberInputs[numberInputs.length - 1] as HTMLInputElement;
    expect(borderWidthInput.value).toBe("2");
    // background color pair + border color pair.
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(4);
  });

  it("writes an edited border width back onto the override's props, keeping its color", async () => {
    const { vm, container } = await renderHarness("root");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    const borderWidthInput = numberInputs[numberInputs.length - 1] as HTMLInputElement;
    fireEvent.change(borderWidthInput, { target: { value: "5" } });
    const node = findNode(vm.config.root, "root") as StackNode;
    expect(node.overrides?.[0]?.props.border).toEqual({ width: 5, color: { light: "#0f1720" } });
  });
});

describe("OverridesSection — text background + corner radius override fields", () => {
  it("renders real background and corner-radius controls, not a silent no-op", async () => {
    const { container } = await renderHarness("t1");
    // color + background = 2 pairs.
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(4);
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(1);
    expect((numberInputs[0] as HTMLInputElement).value).toBe("4");
  });

  it("writes an edited background back onto the override's props", async () => {
    const { vm } = await renderHarness("t1");
    const colorInputs = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    const [, , backgroundLight] = colorInputs;
    fireEvent.change(backgroundLight!, { target: { value: "#a1a1a1" } });
    const node = findNode(vm.config.root, "t1") as TextNode;
    expect(node.overrides?.[0]?.props.background).toEqual({ light: "#a1a1a1" });
  });

  it("writes an edited corner radius back onto the override's props", async () => {
    const { vm, container } = await renderHarness("t1");
    const radiusInput = container.querySelector('input[type="number"]')!;
    fireEvent.change(radiusInput, { target: { value: "10" } });
    const node = findNode(vm.config.root, "t1") as TextNode;
    expect(node.overrides?.[0]?.props.cornerRadius).toBe(10);
  });
});

describe("OverridesSection — image border override field", () => {
  it("renders a real border width input and color inputs, not a silent no-op", async () => {
    const { container } = await renderHarness("img1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    // cornerRadius + border width.
    expect(numberInputs).toHaveLength(2);
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(2);
  });

  it("writes an edited border color back onto the override's props, keeping its width", async () => {
    const { vm } = await renderHarness("img1");
    const [light] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(light!, { target: { value: "#909090" } });
    const node = findNode(vm.config.root, "img1") as ImageNode;
    expect(node.overrides?.[0]?.props.border).toEqual({ width: 1, color: { light: "#909090" } });
  });
});

describe("OverridesSection — button background/labelColor/border/cornerRadius override fields", () => {
  it("renders real controls for all four, not a silent no-op", async () => {
    const { container } = await renderHarness("b1");
    // background + labelColor + border color = 3 pairs.
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(6);
    // border width + cornerRadius.
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(2);
  });

  it("writes an edited background back onto the override's props", async () => {
    const { vm } = await renderHarness("b1");
    const [bgLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(bgLight!, { target: { value: "#1a1a1a" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.overrides?.[0]?.props.background).toEqual({ light: "#1a1a1a" });
  });

  it("writes an edited labelColor back onto the override's props", async () => {
    const { vm } = await renderHarness("b1");
    const [, , labelLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(labelLight!, { target: { value: "#2b2b2b" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.overrides?.[0]?.props.labelColor).toEqual({ light: "#2b2b2b" });
  });

  it("writes an edited border width back onto the override's props, keeping its color", async () => {
    const { vm, container } = await renderHarness("b1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[0]!, { target: { value: "3" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.overrides?.[0]?.props.border).toEqual({ width: 3, color: { light: "#404040" } });
  });

  it("writes an edited corner radius back onto the override's props", async () => {
    const { vm, container } = await renderHarness("b1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[numberInputs.length - 1]!, { target: { value: "9" } });
    const node = findNode(vm.config.root, "b1") as ButtonNode;
    expect(node.overrides?.[0]?.props.cornerRadius).toBe(9);
  });
});

describe("OverridesSection — purchaseButton background/labelColor/border/cornerRadius override fields", () => {
  it("renders real controls for all four, not a silent no-op", async () => {
    const { container } = await renderHarness("pb1");
    expect(screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER)).toHaveLength(6);
    const numberInputs = container.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(2);
  });

  it("writes an edited background back onto the override's props", async () => {
    const { vm } = await renderHarness("pb1");
    const [bgLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(bgLight!, { target: { value: "#3c3c3c" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.overrides?.[0]?.props.background).toEqual({ light: "#3c3c3c" });
  });

  it("writes an edited labelColor back onto the override's props", async () => {
    const { vm } = await renderHarness("pb1");
    const [, , labelLight] = screen.getAllByPlaceholderText(UNSET_HEX_PLACEHOLDER);
    fireEvent.change(labelLight!, { target: { value: "#4d4d4d" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.overrides?.[0]?.props.labelColor).toEqual({ light: "#4d4d4d" });
  });

  it("writes an edited border width back onto the override's props, keeping its color", async () => {
    const { vm, container } = await renderHarness("pb1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[0]!, { target: { value: "4" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.overrides?.[0]?.props.border).toEqual({ width: 4, color: { light: "#606060" } });
  });

  it("writes an edited corner radius back onto the override's props", async () => {
    const { vm, container } = await renderHarness("pb1");
    const numberInputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[numberInputs.length - 1]!, { target: { value: "11" } });
    const node = findNode(vm.config.root, "pb1") as PurchaseButtonNode;
    expect(node.overrides?.[0]?.props.cornerRadius).toBe(11);
  });
});
