import "reflect-metadata";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServiceProvider, useService } from "impair";
import "../../i18n/config";
import { ExperimentPopover } from "./experiment-popover";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import type {
  AudienceRow,
  DashboardPaywallRow,
  DashboardPlacementRow,
  ExperimentListItem,
} from "@rovenue/shared";
import { useExperiments, useStartExperiment } from "../../lib/hooks/useExperiments";
import { useProjectPaywalls } from "../../lib/hooks/useProjectPaywalls";
import { useProjectPlacements } from "../../lib/hooks/useProjectPlacements";
import { useAudiences } from "../../lib/hooks/useProjectAdmin";

// =============================================================
// ExperimentPopover — atomic paywall A/B launch (§3.1). Mounting idiom
// mirrors binding-tab.test.tsx: real impair ServiceProvider + real
// PaywallBuilderViewModel, with PaywallBuilderApi.prototype.get spied to
// hand back a fake detail DTO. Two extra layers on top of that idiom:
//
//   1. useExperiments/useStartExperiment/useProjectPaywalls/
//      useProjectPlacements/useAudiences are vi.mock'd wholesale (no
//      network shape to fake — just return canned react-query-shaped
//      results). useAudiences is the SAME hook useProjectAdmin.ts exports
//      (experiments/new.tsx, audiences/index.tsx, placement-editor.tsx
//      already use it) — the popover must not fragment that cache with a
//      file-local duplicate, so its mock path is that shared module too.
//   2. The launch mutation IS file-local (no shared endpoint to reuse —
//      see the comment in experiment-popover.tsx) and isn't mockable that
//      way, so `rpc`/`unwrap` from lib/api are mocked at the transport
//      layer and the mutation runs for real inside a real
//      QueryClientProvider.
// =============================================================

// `Link` needs a live TanStack Router context this harness doesn't set up
// (no route tree here — the popover is mounted standalone, same as
// diff-modal/start-modal's tests never exercise Link at all). Swap it for
// a plain anchor that resolves `$param` placeholders the same way the real
// router would, so href assertions still exercise the actual `to`/`params`
// this component passes.
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

vi.mock("../../lib/hooks/useExperiments", () => ({
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

function experimentsResult(data: ExperimentListItem[]) {
  return { data, isLoading: false, error: null } as unknown as ReturnType<typeof useExperiments>;
}

function paywallsResult(rows: DashboardPaywallRow[]) {
  return {
    data: { paywalls: rows },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectPaywalls>;
}

function placementsResult(rows: DashboardPlacementRow[]) {
  return {
    data: { placements: rows },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectPlacements>;
}

function startExperimentResult(
  mutate: (id: string) => void,
  isPending = false,
  isError = false,
) {
  return { mutate, isPending, isError } as unknown as ReturnType<typeof useStartExperiment>;
}

function audiencesResult(rows: AudienceRow[]) {
  return { data: rows, isLoading: false, error: null } as unknown as ReturnType<typeof useAudiences>;
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

function fakePaywallRow(overrides: Partial<DashboardPaywallRow> = {}): DashboardPaywallRow {
  return {
    id: "pw_x",
    projectId: "p_1",
    identifier: "pw-x",
    name: "Paywall X",
    offeringId: "off_1",
    remoteConfig: {},
    configFormatVersion: 2,
    builderConfig: {},
    isActive: true,
    status: "draft",
    publishedVersionId: null,
    metadata: {},
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as DashboardPaywallRow;
}

function fakePlacementRow(overrides: Partial<DashboardPlacementRow> = {}): DashboardPlacementRow {
  return {
    id: "plc_1",
    projectId: "p_1",
    identifier: "onboarding",
    name: "Onboarding",
    revision: 1,
    rows: [],
    isActive: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as DashboardPlacementRow;
}

function fakeAudience(overrides: Partial<AudienceRow> = {}): AudienceRow {
  return {
    id: "aud_default",
    projectId: "p_1",
    name: "All Users",
    description: null,
    rules: {},
    isDefault: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function fakeExperiment(overrides: Partial<ExperimentListItem> = {}): ExperimentListItem {
  return {
    id: "exp_1",
    projectId: "p_1",
    name: "Main paywall A/B",
    description: null,
    type: "PAYWALL",
    key: "main-ab",
    audienceId: "aud_default",
    status: "DRAFT",
    variants: [
      { id: "a", name: "Main paywall", value: { paywallId: "pw_a" }, weight: 0.5 },
      { id: "b", name: "Main paywall (B)", value: { paywallId: "pw_b" }, weight: 0.5 },
    ],
    metrics: null,
    mutualExclusionGroup: null,
    startedAt: null,
    completedAt: null,
    winnerVariantId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

async function renderPopover(detailOverrides: Partial<PaywallBuilderDetailDto> = {}) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(detailOverrides));

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <QueryClientProvider client={qc}>
      <ServiceProvider
        provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
        props={{ projectId: "p_1", paywallId: "pw_a" }}
      >
        <Probe />
        <ExperimentPopover onClose={onClose} />
      </ServiceProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, onClose, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseExperiments.mockReturnValue(experimentsResult([]));
  mockedUseStartExperiment.mockReturnValue(startExperimentResult(vi.fn()));
  mockedUseProjectPaywalls.mockReturnValue(paywallsResult([]));
  mockedUseProjectPlacements.mockReturnValue(placementsResult([]));
  mockedUseAudiences.mockReturnValue(audiencesResult([fakeAudience()]));
  launchPost.mockResolvedValue({
    experiment: fakeExperiment(),
    createdPaywallId: "pw_b",
  });
});

describe("ExperimentPopover — create-form branch", () => {
  it("renders with duplicate variant B preselected and ELEMENT disabled", async () => {
    await renderPopover();

    expect(screen.getByDisplayValue("Main paywall A/B")).toBeInTheDocument();

    const duplicateRadio = screen.getByRole("radio", { name: /duplicate this paywall/i });
    const existingRadio = screen.getByRole("radio", { name: /use an existing paywall/i });
    expect(duplicateRadio).toBeChecked();
    expect(existingRadio).not.toBeChecked();
    expect(screen.getByDisplayValue("Main paywall (B)")).toBeInTheDocument();

    const elementRadio = screen.getByRole("radio", { name: /element/i });
    expect(elementRadio).toBeDisabled();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });
});

describe("ExperimentPopover — create posts the exact launch payload", () => {
  it("posts { name, variantB: duplicate, audienceId, placement } with no extra keys", async () => {
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          id: "plc_1",
          identifier: "onboarding",
          rows: [{ audienceId: null, target: { type: "paywall", paywallId: "pw_a" } }],
        }),
      ]),
    );

    await renderPopover();

    // The single candidate row is auto-preselected, and the default
    // audience is already selected via the mocked useAudiences.
    expect(screen.getByText(/Everyone \(default\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create experiment/i }));

    await waitFor(() => {
      expect(launchPost).toHaveBeenCalledTimes(1);
    });

    expect(launchPost).toHaveBeenCalledWith({
      param: { projectId: "p_1", id: "pw_a" },
      json: {
        name: "Main paywall A/B",
        variantB: { kind: "duplicate", name: "Main paywall (B)" },
        audienceId: "aud_default",
        placement: { placementId: "plc_1", rowIndex: 0 },
      },
    });
  });
});

describe("ExperimentPopover — status-panel branch", () => {
  it("renders the status panel when an experiment targets this paywall, Start disabled while variant B is unpublished", async () => {
    mockedUseExperiments.mockReturnValue(experimentsResult([fakeExperiment({ status: "DRAFT" })]));
    mockedUseProjectPaywalls.mockReturnValue(
      paywallsResult([fakePaywallRow({ id: "pw_b", status: "draft" })]),
    );
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(screen.getByText("Main paywall A/B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start experiment/i })).toBeDisabled();
  });

  it("renders a formatted status label, not the raw uppercase enum", async () => {
    mockedUseExperiments.mockReturnValue(
      experimentsResult([fakeExperiment({ status: "RUNNING" })]),
    );
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("RUNNING")).not.toBeInTheDocument();
  });

  it("enables Start once every prerequisite passes, and Start posts the experiment id", async () => {
    const startMutate = vi.fn();
    mockedUseExperiments.mockReturnValue(experimentsResult([fakeExperiment({ status: "DRAFT" })]));
    mockedUseStartExperiment.mockReturnValue(startExperimentResult(startMutate));
    mockedUseProjectPaywalls.mockReturnValue(
      paywallsResult([fakePaywallRow({ id: "pw_b", status: "published" })]),
    );
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    // Variant A (this paywall) must also be published for every check to pass.
    await renderPopover({ status: "published", publishedVersionId: "v_1" });

    const startButton = screen.getByRole("button", { name: /start experiment/i });
    expect(startButton).not.toBeDisabled();

    fireEvent.click(startButton);
    expect(startMutate).toHaveBeenCalledWith("exp_1");
  });

  it("renders a start error line when useStartExperiment.isError is true", async () => {
    mockedUseExperiments.mockReturnValue(experimentsResult([fakeExperiment({ status: "DRAFT" })]));
    mockedUseStartExperiment.mockReturnValue(startExperimentResult(vi.fn(), false, true));
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(
      screen.getByText(/couldn't start the experiment\. try again\./i),
    ).toBeInTheDocument();
  });

  it("renders no start error line when useStartExperiment.isError is false", async () => {
    mockedUseExperiments.mockReturnValue(experimentsResult([fakeExperiment({ status: "DRAFT" })]));
    mockedUseStartExperiment.mockReturnValue(startExperimentResult(vi.fn(), false, false));
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(
      screen.queryByText(/couldn't start the experiment\. try again\./i),
    ).not.toBeInTheDocument();
  });
});

describe("ExperimentPopover — no-placement warning branch", () => {
  it("shows the not-attached warning and a link to placements when no row targets this paywall", async () => {
    await renderPopover();

    expect(
      screen.getByText(/not attached to any placement/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to placements/i })).toHaveAttribute(
      "href",
      "/projects/p_1/placements",
    );
  });
});

describe("ExperimentPopover — status panel results link", () => {
  it("renders a View results link next to View experiment, both pointing at the experiment detail route", async () => {
    mockedUseExperiments.mockReturnValue(experimentsResult([fakeExperiment({ status: "RUNNING" })]));
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(screen.getByRole("link", { name: /view experiment/i })).toHaveAttribute(
      "href",
      "/projects/p_1/experiments/exp_1",
    );
    expect(screen.getByRole("link", { name: /view results/i })).toHaveAttribute(
      "href",
      "/projects/p_1/experiments/exp_1",
    );
  });
});

describe("ExperimentPopover — completed-dark-placement branch", () => {
  it("shows the winnerless copy when a COMPLETED experiment with no winner is still targeted by a placement row", async () => {
    mockedUseExperiments.mockReturnValue(
      experimentsResult([fakeExperiment({ status: "COMPLETED", winnerVariantId: null })]),
    );
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(
      screen.getByText(/this experiment completed without a winner/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/still targets a completed experiment/i),
    ).not.toBeInTheDocument();
  });

  it("shows the winner-present copy when a COMPLETED experiment with a winner is still targeted by a placement row", async () => {
    mockedUseExperiments.mockReturnValue(
      experimentsResult([fakeExperiment({ status: "COMPLETED", winnerVariantId: "a" })]),
    );
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({
          rows: [{ audienceId: null, target: { type: "experiment", experimentId: "exp_1" } }],
        }),
      ]),
    );

    await renderPopover();

    expect(
      screen.getByText(/still targets a completed experiment/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/this experiment completed without a winner/i),
    ).not.toBeInTheDocument();
  });
});

describe("ExperimentPopover — multi-candidate placement selection", () => {
  const threeCandidateRows = [
    { audienceId: null, target: { type: "paywall" as const, paywallId: "pw_a" } },
    { audienceId: null, target: { type: "paywall" as const, paywallId: "pw_a" } },
    { audienceId: null, target: { type: "paywall" as const, paywallId: "pw_a" } },
  ];

  it("preselects nothing and posts without a placement key until one is explicitly picked", async () => {
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({ id: "plc_1", identifier: "onboarding", rows: threeCandidateRows }),
      ]),
    );

    await renderPopover();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    for (const cb of checkboxes) {
      expect(cb).not.toBeChecked();
    }
    // Display label is 1-based ordinal ("row 1", "row 2", "row 3") even
    // though the underlying candidates are 0-indexed.
    expect(screen.getByText("onboarding · row 1")).toBeInTheDocument();
    expect(screen.getByText("onboarding · row 2")).toBeInTheDocument();
    expect(screen.getByText("onboarding · row 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create experiment/i }));

    await waitFor(() => {
      expect(launchPost).toHaveBeenCalledTimes(1);
    });
    const [{ json }] = launchPost.mock.calls[0];
    expect(json).not.toHaveProperty("placement");
  });

  it("posts the picked {placementId, rowIndex} (still 0-based) once a candidate is checked", async () => {
    mockedUseProjectPlacements.mockReturnValue(
      placementsResult([
        fakePlacementRow({ id: "plc_1", identifier: "onboarding", rows: threeCandidateRows }),
      ]),
    );

    await renderPopover();

    fireEvent.click(screen.getByRole("checkbox", { name: "onboarding · row 2" }));

    fireEvent.click(screen.getByRole("button", { name: /create experiment/i }));

    await waitFor(() => {
      expect(launchPost).toHaveBeenCalledTimes(1);
    });
    expect(launchPost).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          placement: { placementId: "plc_1", rowIndex: 1 },
        }),
      }),
    );
  });
});
