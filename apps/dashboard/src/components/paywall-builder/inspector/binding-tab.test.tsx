import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { BindingTab } from "./binding-tab";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import { emptyBuilderConfig, type BuilderConfig, type PackageListNode } from "@rovenue/shared/paywall";
import type { OfferingResolvedPrices } from "@rovenue/shared";
import { useOfferingResolvedPrices } from "../../../lib/hooks/useOfferingResolvedPrices";

// =============================================================
// PackageListBinding — the resolved-price readout is an enhancement
// layer over the packageIds/defaultSelected write path, never a gate:
// preset chips and per-store badges appear only once useOfferingResolvedPrices
// resolves, but toggling a checkbox and writing packageIds must work
// identically whether the hook has data, is loading, or errors.
// =============================================================

vi.mock("../../../lib/hooks/useOfferingResolvedPrices", () => ({
  useOfferingResolvedPrices: vi.fn(),
}));

const mockedUseOfferingResolvedPrices = vi.mocked(useOfferingResolvedPrices);

function resolvedPricesFixture(): OfferingResolvedPrices {
  return {
    offeringId: "off_1",
    fetchedAt: "2026-07-27T00:00:00.000Z",
    packages: [
      {
        packageIdentifier: "pkg_month",
        productId: "prod_month",
        displayName: "Monthly Plan",
        metadataPeriod: null,
        stores: {
          apple: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: 7 },
          stripe: { status: "ok", amountMinor: 999, currency: "USD", period: "P1M", trialDays: null },
        },
      },
      {
        packageIdentifier: "pkg_year",
        productId: "prod_year",
        displayName: "Annual Plan",
        metadataPeriod: null,
        stores: {
          apple: { status: "ok", amountMinor: 6999, currency: "USD", period: "P1Y", trialDays: null },
        },
      },
    ],
  };
}

function resolvedPricesWithConflict(): OfferingResolvedPrices {
  const base = resolvedPricesFixture();
  base.packages.push({
    packageIdentifier: "pkg_conflict",
    productId: "prod_conflict",
    displayName: "Confusing Plan",
    metadataPeriod: null,
    stores: {
      apple: { status: "ok", amountMinor: 500, currency: "USD", period: "P1M", trialDays: null },
      google: { status: "ok", amountMinor: 500, currency: "USD", period: "P1Y", trialDays: null },
    },
  });
  return base;
}

function fakeConfig(offeringPackageIds: readonly string[]): {
  config: BuilderConfig;
  node: PackageListNode;
} {
  const config = emptyBuilderConfig("en");
  const node: PackageListNode = {
    type: "packageList",
    id: "pl1",
    packageIds: [...offeringPackageIds],
    defaultSelected: offeringPackageIds[0],
    cellLayout: "row",
  };
  config.root.children.push(node);
  return { config, node };
}

function fakeDetail(config: BuilderConfig, offeringPackageIds: readonly string[]): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    builderConfig: config,
    defaultLocale: "en",
    offeringPackageIds: [...offeringPackageIds],
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
  return <BindingTab node={node} />;
});

/** Mounts BindingTab inside real DI, loaded from a fake config, and hands back the live VM. */
async function renderHarness(offeringPackageIds: readonly string[]) {
  const { config } = fakeConfig(offeringPackageIds);
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(config, offeringPackageIds));

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
      <Harness id="pl1" />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

describe("PackageListBinding — preset chips", () => {
  it("clicking a preset chip writes exactly that preset's packageIds and clears an excluded defaultSelected", async () => {
    mockedUseOfferingResolvedPrices.mockReturnValue({
      data: resolvedPricesFixture(),
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useOfferingResolvedPrices>);

    const { vm } = await renderHarness(["pkg_month", "pkg_year"]);

    // defaultSelected starts on pkg_month (fakeConfig picks offeringPackageIds[0]).
    let node = findNode(vm.config.root, "pl1") as PackageListNode;
    expect(node.defaultSelected).toBe("pkg_month");

    fireEvent.click(screen.getByRole("button", { name: "Annual" }));

    node = findNode(vm.config.root, "pl1") as PackageListNode;
    expect(node.packageIds).toEqual(["pkg_year"]);
    expect(node.defaultSelected).toBeUndefined();
  });
});

describe("PackageListBinding — resolved row readout", () => {
  it("shows displayName, period label and per-store badge text", async () => {
    mockedUseOfferingResolvedPrices.mockReturnValue({
      data: resolvedPricesFixture(),
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useOfferingResolvedPrices>);

    await renderHarness(["pkg_month", "pkg_year"]);

    // Scope to each package row (its <label>) since "Monthly"/"Annual" also
    // appear as preset-strip chip labels — the row-level assertions below
    // must find the period text INSIDE the row, not just anywhere on screen.
    const monthlyRow = screen.getByText("Monthly Plan").closest("label")!;
    const annualRow = screen.getByText("Annual Plan").closest("label")!;

    expect(within(monthlyRow).getByText("Monthly")).toBeInTheDocument();
    expect(within(monthlyRow).getByText("Apple $9.99 · 7d trial")).toBeInTheDocument();
    expect(within(monthlyRow).getByText("Stripe $9.99")).toBeInTheDocument();

    expect(within(annualRow).getByText("Annual")).toBeInTheDocument();
    expect(within(annualRow).getByText("Apple $69.99")).toBeInTheDocument();
  });
});

describe("PackageListBinding — hook failure degrades to id-only rows", () => {
  it("renders old id-only rows and toggling still writes packageIds when the hook errors", async () => {
    mockedUseOfferingResolvedPrices.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("resolved-prices upstream failure"),
    } as unknown as ReturnType<typeof useOfferingResolvedPrices>);

    const { vm } = await renderHarness(["pkg_month", "pkg_year"]);

    // No enhancement layer: no displayName, no period chip, no preset strip.
    expect(screen.queryByText("Monthly Plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Monthly")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Annual" })).not.toBeInTheDocument();

    // The raw ids are still rendered (both as the id-only label and the mono
    // id caption, since displayName is null with no resolved data), and the
    // checkbox still toggles packageIds.
    expect(screen.getAllByText("pkg_month")).toHaveLength(2);

    act(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: "pkg_year" }));
    });

    const node = findNode(vm.config.root, "pl1") as PackageListNode;
    expect(node.packageIds).toEqual(["pkg_month"]);
  });
});

describe("PackageListBinding — period conflict marker", () => {
  it("renders a warning marker on a row whose stores disagree on billing period", async () => {
    mockedUseOfferingResolvedPrices.mockReturnValue({
      data: resolvedPricesWithConflict(),
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useOfferingResolvedPrices>);

    await renderHarness(["pkg_month", "pkg_year", "pkg_conflict"]);

    const conflictChip = screen.getByText((content) => content.includes("⚠"));
    expect(conflictChip).toBeInTheDocument();
    expect(conflictChip).toHaveAttribute("title");
  });
});
