import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../tests/msw/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import i18n from "../../../i18n/config";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";
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
// bridge (notifying `dispatchPaywallPatch` once an intent executes); this
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
  const getSpy = vi
    .spyOn(PaywallBuilderApi.prototype, "get")
    .mockResolvedValue(fakeDetail(detailOverrides));

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
    getSpy,
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
  // As of Task 5, an approved `action_paywall_editTree` intent is
  // PERSISTED server-side by the intent handler itself — the dashboard no
  // longer applies the op locally (that produced a double-apply: the
  // handler's write plus the client re-applying the same op and
  // autosaving it landed the op twice). `dispatchPaywallPatch` now takes
  // only a `paywallId` and the registered listener re-fetches the draft
  // the server already wrote, instead of receiving an op to apply.

  it("notifies the listener registered under its OWN paywallId while mounted, which re-fetches the persisted draft; unregisters on unmount", async () => {
    const { getVm, getRovi, getSpy, unmountBuilder } = await renderBridge();
    const vm = getVm();
    const callsBeforeNotify = getSpy.mock.calls.length;

    const updatedDetail = fakeDetail();
    (updatedDetail.builderConfig as BuilderConfig).root.children.push({
      type: "spacer",
      id: "sp_from_server",
      size: 8,
    });
    getSpy.mockResolvedValueOnce(updatedDetail);

    let notified = false;
    act(() => {
      notified = getRovi().dispatchPaywallPatch("pw_a");
    });
    expect(notified).toBe(true);

    // The listener's refetch is async (fire-and-forget from the
    // synchronous dispatch), so the resulting config update lands on a
    // later tick.
    await waitFor(() => expect(getSpy.mock.calls.length).toBe(callsBeforeNotify + 1));
    await waitFor(() =>
      expect(vm.config.root.children.some((c) => c.id === "sp_from_server")).toBe(true),
    );

    act(() => {
      unmountBuilder();
    });

    let notifiedAfterUnmount = true;
    act(() => {
      notifiedAfterUnmount = getRovi().dispatchPaywallPatch("pw_a");
    });
    expect(notifiedAfterUnmount).toBe(false);
    expect(getSpy.mock.calls.length).toBe(callsBeforeNotify + 1); // no further refetch
  });

  it("refuses a notification addressed to a DIFFERENT paywallId than the one this builder has open, and never refetches", async () => {
    // Cross-paywall guard (spec §3.3): every paywall's root id is
    // literally "root", so an unscoped op would look valid here too —
    // the notification itself must still be scoped even though it no
    // longer carries an op.
    const { getVm, getRovi, getSpy } = await renderBridge();
    const vm = getVm();
    const before = JSON.stringify(vm.config);
    const callsBeforeNotify = getSpy.mock.calls.length;

    let notified = true;
    act(() => {
      notified = getRovi().dispatchPaywallPatch("pw_other");
    });

    expect(notified).toBe(false);
    expect(getSpy.mock.calls.length).toBe(callsBeforeNotify);
    expect(JSON.stringify(vm.config)).toBe(before);
  });

  it("a failed refetch after a notified edit is swallowed, not thrown at the caller", async () => {
    const { getRovi, getSpy } = await renderBridge();
    getSpy.mockRejectedValueOnce(new Error("network down"));

    let notified = false;
    expect(() => {
      act(() => {
        notified = getRovi().dispatchPaywallPatch("pw_a");
      });
    }).not.toThrow();
    expect(notified).toBe(true);

    // Let the rejected refetch promise settle without an unhandled
    // rejection reaching the test runner.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

describe("static i18n keys", () => {
  it("registers paywalls.builder.ai.fabLabel with the FAB's fallback copy", () => {
    expect(i18n.t("paywalls.builder.ai.fabLabel")).toBe("Ask Rovi");
  });
});
