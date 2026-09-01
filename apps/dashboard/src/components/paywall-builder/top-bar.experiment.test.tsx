import "reflect-metadata";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServiceProvider, useService } from "impair";
import "../../i18n/config";
import { TopBar } from "./top-bar";
import { BuilderShell } from "./builder-shell";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { RoviProvider } from "../rovi/rovi-provider";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { useExperiments, useStartExperiment } from "../../lib/hooks/useExperiments";
import { useProjectPaywalls } from "../../lib/hooks/useProjectPaywalls";
import { useProjectPlacements } from "../../lib/hooks/useProjectPlacements";
import { useAudiences } from "../../lib/hooks/useProjectAdmin";

// =============================================================
// Task 5 — TopBar wiring for the experiment popover (Task 4's
// ExperimentPopover). Two scopes in one file per the brief:
//
//   1. TopBar in isolation — the flask button calls onOpenExperiment,
//      and is disabled with a tooltip while publishedVersionId is null.
//      Mounting idiom mirrors experiment-popover.test.tsx: real impair
//      ServiceProvider + real PaywallBuilderViewModel, PaywallBuilderApi
//      .prototype.get spied to hand back a fake detail DTO.
//
//   2. BuilderShell — no test file exists for builder-shell.tsx (grepped
//      first, per the brief), so its showExperiment/onOpenExperiment
//      mount-unmount wiring is covered here instead of a separate file.
//      LayerTree/Canvas/PropertiesPanel/ValidationDrawer/DiffModal/
//      LocalizationModal/StartModal are stubbed to null — none of them
//      are under test — and the experiment data hooks are vi.mock'd
//      wholesale exactly as experiment-popover.test.tsx does, since
//      opening the real ExperimentPopover exercises those hooks too.
// =============================================================

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      params,
      children,
      className,
    }: {
      to: string;
      params?: Record<string, string>;
      children?: ReactNode;
      className?: string;
    }) => {
      const href = Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      );
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    },
  };
});

vi.mock("./layer-tree", () => ({ LayerTree: () => null }));
vi.mock("./canvas", () => ({ Canvas: () => null }));
vi.mock("./properties-panel", () => ({ PropertiesPanel: () => null }));
vi.mock("./validation-drawer", () => ({ ValidationDrawer: () => null }));
vi.mock("./diff-modal", () => ({ DiffModal: () => null }));
vi.mock("./localization-modal", () => ({ LocalizationModal: () => null }));
vi.mock("./start-modal", () => ({ StartModal: () => null }));
vi.mock("./device-preview-modal", () => ({ DevicePreviewModal: () => null }));

vi.mock("../../lib/hooks/useExperiments", () => ({
  // The popover creates ELEMENT experiments through the shared endpoint.
  useCreateExperiment: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useExperiments: vi.fn(),
  useStartExperiment: vi.fn(),
}));
vi.mock("../../lib/hooks/useProjectPaywalls", () => ({
  useProjectPaywalls: vi.fn(),
}));
vi.mock("../../lib/hooks/useProjectPlacements", () => ({
  useProjectPlacements: vi.fn(),
}));
vi.mock("../../lib/hooks/useProjectAdmin", () => ({
  useAudiences: vi.fn(),
}));

const launchPost = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({
  rpc: {
    dashboard: {
      projects: {
        ":projectId": {
          paywalls: {
            ":id": { experiments: { $post: launchPost } },
          },
        },
      },
    },
  },
  unwrap: vi.fn(async (p: unknown) => p),
}));

const mockedUseExperiments = vi.mocked(useExperiments);
const mockedUseStartExperiment = vi.mocked(useStartExperiment);
const mockedUseProjectPaywalls = vi.mocked(useProjectPaywalls);
const mockedUseProjectPlacements = vi.mocked(useProjectPlacements);
const mockedUseAudiences = vi.mocked(useAudiences);

function fakeDetail(overrides: Partial<PaywallBuilderDetailDto> = {}): PaywallBuilderDetailDto {
  return {
    id: "pw_a",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    builderConfig: emptyBuilderConfig("en"),
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "published",
    publishedVersionId: "v_1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseExperiments.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useExperiments>);
  mockedUseStartExperiment.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useStartExperiment>);
  mockedUseProjectPaywalls.mockReturnValue({
    data: { paywalls: [] },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectPaywalls>);
  mockedUseProjectPlacements.mockReturnValue({
    data: { placements: [] },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectPlacements>);
  mockedUseAudiences.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useAudiences>);
});

async function renderTopBar(detailOverrides: Partial<PaywallBuilderDetailDto> = {}) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(detailOverrides));

  const onOpenExperiment = vi.fn();

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <ServiceProvider
      provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
      props={{ projectId: "p_1", paywallId: "pw_a" }}
    >
      <Probe />
      <TopBar
        projectId="p_1"
        onOpenValidation={vi.fn()}
        onOpenDiff={vi.fn()}
        onOpenLocalization={vi.fn()}
        onOpenStart={vi.fn()}
        onOpenExperiment={onOpenExperiment}
        onOpenDevicePreview={vi.fn()}
      />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, onOpenExperiment, ...utils };
}

async function renderShell(detailOverrides: Partial<PaywallBuilderDetailDto> = {}) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(detailOverrides));

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <QueryClientProvider client={qc}>
      {/* BuilderShell now mounts the AI FAB (Task 5, §6.15) and calls
          useRovi() unconditionally — it must render inside a RoviProvider,
          same as it does in the real app (see the $projectId route layout). */}
      <RoviProvider>
        <ServiceProvider
          provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
          props={{ projectId: "p_1", paywallId: "pw_a" }}
        >
          <Probe />
          <BuilderShell projectId="p_1" />
        </ServiceProvider>
      </RoviProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

describe("TopBar — experiment launch button", () => {
  it("calls onOpenExperiment when clicked and the paywall is published", async () => {
    const { onOpenExperiment } = await renderTopBar({
      status: "published",
      publishedVersionId: "v_1",
    });

    const button = screen.getByTitle("A/B test this paywall");
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    expect(onOpenExperiment).toHaveBeenCalledTimes(1);
  });

  it("disables the button with a tooltip while publishedVersionId is null", async () => {
    const { onOpenExperiment } = await renderTopBar({
      status: "draft",
      publishedVersionId: null,
    });

    const button = screen.getByTitle("Publish this paywall before starting an A/B test");
    expect(button).toBeDisabled();

    fireEvent.click(button);

    expect(onOpenExperiment).not.toHaveBeenCalled();
  });
});

describe("TopBar — device preview button", () => {
  it("calls onOpenDevicePreview when the Smartphone button is clicked", async () => {
    vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail());
    const onOpenDevicePreview = vi.fn();

    let vm!: PaywallBuilderViewModel;
    function Probe() {
      vm = useService(PaywallBuilderViewModel);
      return null;
    }

    render(
      <ServiceProvider
        provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
        props={{ projectId: "p_1", paywallId: "pw_a" }}
      >
        <Probe />
        <TopBar
          projectId="p_1"
          onOpenValidation={vi.fn()}
          onOpenDiff={vi.fn()}
          onOpenLocalization={vi.fn()}
          onOpenStart={vi.fn()}
          onOpenExperiment={vi.fn()}
          onOpenDevicePreview={onOpenDevicePreview}
        />
      </ServiceProvider>,
    );

    await act(async () => {
      await vm.load(() => {});
    });

    fireEvent.click(screen.getByTitle("Preview on a device"));

    expect(onOpenDevicePreview).toHaveBeenCalledTimes(1);
  });
});

describe("BuilderShell — experiment popover mount/unmount", () => {
  it("mounts ExperimentPopover on flask click and unmounts it on close", async () => {
    await renderShell({ status: "published", publishedVersionId: "v_1" });

    expect(screen.queryByText("A/B test this paywall")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("A/B test this paywall"));

    expect(screen.getByText("A/B test this paywall")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Close"));

    expect(screen.queryByText("A/B test this paywall")).not.toBeInTheDocument();
  });
});
