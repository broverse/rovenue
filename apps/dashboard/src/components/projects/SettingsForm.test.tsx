import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDetail } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom — an
// absent key renders as the raw key path (en.json has no missing-key
// handler), which would otherwise pass silently against a mocked t().
import "../../i18n/config";
import { SettingsForm } from "./SettingsForm";

const useCommissionRates = vi.hoisted(() => vi.fn());
const useUpdateCommissionRate = vi.hoisted(() => vi.fn());
const useDeleteCommissionRate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useCommissionRates", () => ({
  useCommissionRates,
  useUpdateCommissionRate,
  useDeleteCommissionRate,
}));

// SettingsForm's basics/holdout fields write through this hook on the
// outer form's submit; none of the commission-rate cases below submit
// that form, but the hook still runs (every render calls it), so it
// must exist.
vi.mock("../../lib/hooks/useUpdateProject", () => ({
  useUpdateProject: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: "proj_1",
    name: "Test project",
    description: null,
    webhookUrl: null,
    hasWebhookSecret: false,
    webhookEventCategories: [],
    holdoutPercentage: 0,
    settings: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    counts: { subscribers: 0, experiments: 0, featureFlags: 0, activeApiKeys: 0 },
    apiKeys: [],
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function arrangeMutations() {
  const update = { mutate: vi.fn(), isPending: false, error: null as Error | null };
  const del = { mutate: vi.fn(), isPending: false, error: null as Error | null };
  useUpdateCommissionRate.mockReturnValue(update);
  useDeleteCommissionRate.mockReturnValue(del);
  return { update, del };
}

describe("SettingsForm — commission rates", () => {
  it("issues no write when a project with no configured rates is rendered", () => {
    useCommissionRates.mockReturnValue({ data: [], isLoading: false });
    const { update, del } = arrangeMutations();

    wrap(<SettingsForm project={project()} />);

    // Every store must report "not configured" — never a silently
    // assumed rate — and mounting the form must not itself write.
    expect(screen.getByTestId("commission-rate-status-APP_STORE")).toHaveTextContent(
      /not configured/i,
    );
    expect(screen.getByTestId("commission-rate-status-PLAY_STORE")).toHaveTextContent(
      /not configured/i,
    );
    expect(screen.getByTestId("commission-rate-status-STRIPE")).toHaveTextContent(
      /not configured/i,
    );
    expect(screen.getByTestId("commission-rate-status-MANUAL")).toHaveTextContent(
      /not configured/i,
    );
    expect(update.mutate).not.toHaveBeenCalled();
    expect(del.mutate).not.toHaveBeenCalled();
  });

  it("clicking a preset fills the input but still issues no write", () => {
    useCommissionRates.mockReturnValue({ data: [], isLoading: false });
    const { update, del } = arrangeMutations();

    wrap(<SettingsForm project={project()} />);

    // The Apple Small Business preset lives on the APP_STORE row and
    // carries its sourced citation verbatim, not a summary.
    const presetCard = screen.getByTestId("commission-rate-preset-APPLE_SMALL_BUSINESS");
    expect(presetCard).toHaveTextContent(
      /a reduced commission rate of 15% on paid apps and In-App Purchases/,
    );
    expect(presetCard).toHaveTextContent(
      "https://developer.apple.com/app-store/small-business-program/",
    );

    fireEvent.click(within(presetCard).getByRole("button", { name: /use this preset/i }));

    const input = screen.getByTestId("commission-rate-row-APP_STORE").querySelector("input")!;
    expect(input).toHaveValue(15);
    // Offering a preset is not configuring one.
    expect(update.mutate).not.toHaveBeenCalled();
    expect(del.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("commission-rate-status-APP_STORE"),
    ).toHaveTextContent(/not configured/i);
  });

  it("clicking Save after entering a rate writes through the PUT-backed mutation", () => {
    useCommissionRates.mockReturnValue({ data: [], isLoading: false });
    const { update } = arrangeMutations();

    wrap(<SettingsForm project={project()} />);

    const row = screen.getByTestId("commission-rate-row-PLAY_STORE");
    const input = row.querySelector("input")!;
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.click(within(row).getByRole("button", { name: /save rate/i }));

    expect(update.mutate).toHaveBeenCalledTimes(1);
    expect(update.mutate).toHaveBeenCalledWith({ store: "PLAY_STORE", rate: 0.15 });
  });

  it("renders a configured rate and clears it through the DELETE-backed mutation", () => {
    useCommissionRates.mockReturnValue({
      data: [{ store: "STRIPE", rate: 0.029 }],
      isLoading: false,
    });
    const { del } = arrangeMutations();

    wrap(<SettingsForm project={project()} />);

    expect(screen.getByTestId("commission-rate-status-STRIPE")).toHaveTextContent(
      "2.90% configured",
    );

    fireEvent.click(
      screen.getByTestId("commission-rate-row-STRIPE").querySelector(
        "button:last-of-type",
      )!,
    );

    expect(del.mutate).toHaveBeenCalledWith("STRIPE");
  });

  it("surfaces the server's error string on a denied write (matches the endpoint's capability gate) without any client-side role check", () => {
    useCommissionRates.mockReturnValue({ data: [], isLoading: false });
    useUpdateCommissionRate.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: new Error("Forbidden: requires capability project:settings:write"),
    });
    useDeleteCommissionRate.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });

    wrap(<SettingsForm project={project()} />);

    expect(
      screen.getAllByText(/requires capability project:settings:write/i).length,
    ).toBeGreaterThan(0);
  });
});
