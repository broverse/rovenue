import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import i18n from "../../../i18n/config";
import { emptyBuilderConfig, type BuilderConfig, type PaywallTreeOp } from "@rovenue/shared/paywall";
import { BuilderShell } from "../builder-shell";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { RoviProvider } from "../../rovi/rovi-provider";
import { useRovi } from "../../../lib/hooks/useRovi";

// =============================================================
// P8 §6.15 Task 5 — the AI FAB + Rovi->builder bridge, as seen from
// builder-shell.tsx: the FAB opens the Rovi panel via RoviProvider's
// `open`/`setOpen`, chatContext tracks the open paywall + selected node,
// and a VM patch listener registers/unregisters with the builder's
// mount lifecycle. approval-card.test.tsx covers the OTHER end of the
// bridge (forwarding an executed op into `dispatchPaywallPatch`); this
// file covers builder-shell's side of the same contract.
//
// Every sibling panel (LayerTree/Canvas/PropertiesPanel/TopBar/…) is
// stubbed to null — none of them are under test here, same idiom as
// top-bar.experiment.test.tsx's `renderShell`.
// =============================================================

// BuilderShell's mount fetches the version list and the draft-vs-published
// diff. Neither is under test here, but leaving them unhandled made MSW log
// six "intercepted a request without a matching request handler" errors per
// run — which blunts `onUnhandledRequest: "error"` for every OTHER request in
// this file, the signal that setting actually exists to give. Both shapes are
// the real ones (`DashboardPaywallVersionRow[]`, `DashboardPaywallDiffResponse`
// in @rovenue/shared), empty rather than invented, so nothing here can pass by
// asserting against fabricated content.
const PROJECT_ID = "p_1";
const PAYWALL_ID = "pw_a";
const PAYWALL_PATH = `/dashboard/projects/${PROJECT_ID}/paywalls/${PAYWALL_ID}`;

beforeEach(() => {
  server.use(
    http.get(`*${PAYWALL_PATH}/versions`, () =>
      HttpResponse.json({ data: { versions: [] } }),
    ),
    http.get(`*${PAYWALL_PATH}/diff`, () =>
      HttpResponse.json({
        data: {
          from: { versionNo: null, label: null },
          to: { versionNo: null, label: null },
          entries: [],
        },
      }),
    ),
  );
});

vi.mock("../top-bar", () => ({ TopBar: () => null }));
vi.mock("../layer-tree", () => ({ LayerTree: () => null }));
vi.mock("../canvas", () => ({ Canvas: () => null }));
vi.mock("../properties-panel", () => ({ PropertiesPanel: () => null }));
vi.mock("../validation-drawer", () => ({ ValidationDrawer: () => null }));
vi.mock("../diff-modal", () => ({ DiffModal: () => null }));
vi.mock("../localization-modal", () => ({ LocalizationModal: () => null }));
vi.mock("../start-modal", () => ({ StartModal: () => null }));
vi.mock("../experiment-popover", () => ({ ExperimentPopover: () => null }));

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({ type: "text", id: "t1", key: "t1_key", role: "title" });
  config.localizations.en!.t1_key = "Hello";
  return config;
}

function fakeDetail(overrides: Partial<PaywallBuilderDetailDto> = {}): PaywallBuilderDetailDto {
  return {
    id: "pw_a",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    draftRevision: 0,
    builderConfig: fakeConfig(),
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
    ...overrides,
  };
}

async function renderBridge(detailOverrides: Partial<PaywallBuilderDetailDto> = {}) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(detailOverrides));

  let vm!: PaywallBuilderViewModel;
  let rovi!: ReturnType<typeof useRovi>;

  function VmProbe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }
  function RoviProbe() {
    rovi = useRovi();
    return null;
  }
  function Harness({ show }: { show: boolean }) {
    return (
      <RoviProvider>
        <RoviProbe />
        {show && (
          <ServiceProvider
            provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
            props={{ projectId: "p_1", paywallId: "pw_a" }}
          >
            <VmProbe />
            <BuilderShell projectId="p_1" />
          </ServiceProvider>
        )}
      </RoviProvider>
    );
  }

  const utils = render(<Harness show />);
  await act(async () => {
    await vm.load(() => {});
  });

  return {
    getVm: () => vm,
    getRovi: () => rovi,
    unmountBuilder: () => utils.rerender(<Harness show={false} />),
    ...utils,
  };
}

describe("builder-shell — AI FAB", () => {
  it("renders the FAB and opens the Rovi panel on click; hides while the panel is open", async () => {
    const { getRovi } = await renderBridge();

    const fab = screen.getByRole("button", { name: "Ask Rovi" });
    expect(fab).toBeInTheDocument();
    expect(getRovi().open).toBe(false);

    fireEvent.click(fab);

    expect(getRovi().open).toBe(true);
    expect(screen.queryByRole("button", { name: "Ask Rovi" })).not.toBeInTheDocument();
  });
});

describe("builder-shell — chatContext", () => {
  it("sets chatContext.paywallId on mount and tracks the selected node as focusedEntityId", async () => {
    const { getVm, getRovi } = await renderBridge();
    const vm = getVm();

    expect(getRovi().chatContext).toEqual({ paywallId: "pw_a", focusedEntityId: undefined });

    // impair's `component()` re-render is scheduled via a debounced
    // `queueMicrotask` (see node_modules/impair's `me()` helper) rather
    // than synchronously — a plain sync `act()` returns before that
    // microtask drains, so the effect that reads `vm.selectedNodeId`
    // wouldn't have re-run yet. `await act(async () => …)` flushes it.
    await act(async () => {
      vm.selectNode("t1");
    });
    expect(getRovi().chatContext).toEqual({ paywallId: "pw_a", focusedEntityId: "t1" });

    await act(async () => {
      vm.selectNode(null);
    });
    expect(getRovi().chatContext).toEqual({ paywallId: "pw_a", focusedEntityId: undefined });
  });

  it("clears chatContext when the builder unmounts", async () => {
    const { getRovi, unmountBuilder } = await renderBridge();

    expect(getRovi().chatContext.paywallId).toBe("pw_a");

    act(() => {
      unmountBuilder();
    });

    expect(getRovi().chatContext).toEqual({});
  });
});

describe("builder-shell — VM patch listener registration", () => {
  it("registers a listener under its OWN paywallId while mounted and unregisters it on unmount", async () => {
    const { getVm, getRovi, unmountBuilder } = await renderBridge();
    const vm = getVm();

    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp_bridge", size: 8 },
    };

    let applied = false;
    act(() => {
      applied = getRovi().dispatchPaywallPatch(op, "pw_a");
    });
    expect(applied).toBe(true);
    expect(vm.config.root.children.some((c) => c.id === "sp_bridge")).toBe(true);

    act(() => {
      unmountBuilder();
    });

    let appliedAfterUnmount = true;
    act(() => {
      appliedAfterUnmount = getRovi().dispatchPaywallPatch(
        {
          kind: "insert",
          parentId: "root",
          index: 0,
          subtree: { type: "spacer", id: "sp_after_unmount", size: 8 },
        },
        "pw_a",
      );
    });
    expect(appliedAfterUnmount).toBe(false);
  });

  it("refuses a patch addressed to a DIFFERENT paywallId than the one this builder has open", async () => {
    // Cross-paywall guard (spec §3.3): every paywall's root id is
    // literally "root", so an unscoped op would look valid here too.
    const { getVm, getRovi } = await renderBridge();
    const vm = getVm();
    const before = JSON.stringify(vm.config);

    let applied = true;
    act(() => {
      applied = getRovi().dispatchPaywallPatch(
        {
          kind: "insert",
          parentId: "root",
          index: 0,
          subtree: { type: "spacer", id: "sp_other_paywall", size: 8 },
        },
        "pw_other",
      );
    });

    expect(applied).toBe(false);
    expect(JSON.stringify(vm.config)).toBe(before);
  });

  it("a failed op (bad target) is swallowed into a `false` return, not thrown at the caller", async () => {
    const { getRovi } = await renderBridge();

    let applied = true;
    act(() => {
      applied = getRovi().dispatchPaywallPatch({ kind: "remove", nodeId: "does-not-exist" }, "pw_a");
    });
    expect(applied).toBe(false);
  });
});

describe("static i18n keys", () => {
  it("registers paywalls.builder.ai.fabLabel with the FAB's fallback copy", () => {
    expect(i18n.t("paywalls.builder.ai.fabLabel")).toBe("Ask Rovi");
  });
});
