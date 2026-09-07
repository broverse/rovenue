import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../i18n/config";

// The translate mutation goes through `usePaywallTranslate`, which calls the
// back-compat `api()` shim in `lib/api.ts` — mocked here at the SAME seam
// `start-modal.test.tsx` mocks `rpc`/`unwrap` at, so a 429/412/422 comes
// back as the real `ApiError` the component must handle.
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

// RoviMissingConfig renders a tanstack-router <Link>, which needs a live
// router — stubbed exactly as start-modal.test.tsx stubs it, so this suite
// only pins the WIRING (the 412 branch renders it), not its internals.
vi.mock("../rovi/rovi-missing-config", () => ({
  RoviMissingConfig: () => <div>Rovi needs an API key</div>,
}));

import { LocalizationModal } from "./localization-modal";
import { ApiError } from "../../lib/api";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { emptyBuilderConfig, type BuilderConfig, type TextNode } from "@rovenue/shared/paywall";

// The modal now owns a react-query mutation (auto-translate), so it needs the
// provider the app mounts it under. Retries off: a test that reaches the
// network path should fail fast rather than back off three times.
const queryClient = new QueryClient({
  defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
});

// =============================================================
// LocalizationModal — the `focusKey` jump-to-translation prop
// (`inspector/fields.tsx`'s translate button, wired through
// `PaywallBuilderViewModel.openLocalizationModal`/`BuilderShell`).
//
// jsdom has no `scrollIntoView` implementation at all (calling it throws),
// so it's stubbed per-test rather than added to the shared `tests/setup.ts`
// — nothing else in this suite needs it.
// =============================================================

const KEY_A = "k_a";
const KEY_B = "k_b";

function fakeConfig(withEs = false): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({ type: "text", id: "t_a", key: KEY_A, role: "title" } as TextNode);
  config.root.children.push({ type: "text", id: "t_b", key: KEY_B, role: "body" } as TextNode);
  config.localizations = {
    en: { [KEY_A]: "Hello", [KEY_B]: "World" },
    ...(withEs ? { es: {} } : {}),
  };
  return config;
}

function fakeDetail(withEs = false): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    draftRevision: 0,
    builderConfig: fakeConfig(withEs),
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

async function renderHarness(focusKey?: string | null, withEs = false) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail(withEs));

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ServiceProvider
        provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
        props={{ projectId: "p_1", paywallId: "pw_1" }}
      >
        <Probe />
        <LocalizationModal onClose={() => {}} focusKey={focusKey} />
      </ServiceProvider>
    </QueryClientProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

describe("LocalizationModal — focusKey", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("highlights the focused row and scrolls it into view", async () => {
    await renderHarness(KEY_A);

    const row = screen.getByTestId(`loc-row-${KEY_A}`);
    expect(row.className).toContain("ring-rv-accent-500");
    expect(scrollIntoView).toHaveBeenCalled();

    const otherRow = screen.getByTestId(`loc-row-${KEY_B}`);
    expect(otherRow.className).not.toContain("ring-rv-accent-500");
  });

  it("highlights no row when unfocused (the top bar's own, ordinary open)", async () => {
    await renderHarness(null);

    expect(screen.getByTestId(`loc-row-${KEY_A}`).className).not.toContain("ring-rv-accent-500");
    expect(screen.getByTestId(`loc-row-${KEY_B}`).className).not.toContain("ring-rv-accent-500");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("clears the highlight once the focus key is cleared (on close), without affecting a later normal open", async () => {
    const { rerender, vm } = await renderHarness(KEY_A);
    expect(screen.getByTestId(`loc-row-${KEY_A}`).className).toContain("ring-rv-accent-500");

    await act(async () => {
      rerender(
        <QueryClientProvider client={queryClient}>
          <ServiceProvider
            provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
            props={{ projectId: "p_1", paywallId: "pw_1" }}
          >
            <LocalizationModal onClose={() => {}} focusKey={null} />
          </ServiceProvider>
        </QueryClientProvider>,
      );
    });

    expect(screen.getByTestId(`loc-row-${KEY_A}`).className).not.toContain("ring-rv-accent-500");
    expect(vm.config.localizations.en?.[KEY_A]).toBe("Hello"); // unaffected by the rerender
  });
});

// =============================================================
// A rejected `translate.mutateAsync` used to be swallowed by a bare
// `try/finally` — the spinner stopped, nothing else on screen changed,
// and the promise's rejection went unhandled. Every case below fires the
// SAME translate button and checks: (1) the spinner stops, (2) something
// visibly distinguishes the failure kind.
// =============================================================
describe("LocalizationModal — translate failures", () => {
  beforeEach(() => {
    apiMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces a 429 quota-exceeded failure with its own message, not silence", async () => {
    apiMock.mockRejectedValue(new ApiError("ROVI_QUOTA_EXCEEDED", "Monthly limit reached", 429));
    await renderHarness(null, true);

    const button = screen.getByRole("button", { name: "Translate" });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(await screen.findByText(/monthly quota is used up/i)).toBeInTheDocument();
    // The spinner (Loader2) must not still be showing — the button reverts
    // to its idle "Translate" state so a retry is possible.
    expect(button).not.toBeDisabled();
  });

  it("surfaces a 412 not-configured failure via the same RoviMissingConfig affordance the start tab uses", async () => {
    apiMock.mockRejectedValue(new ApiError("ROVI_NOT_CONFIGURED", "no provider", 412));
    await renderHarness(null, true);

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));

    expect(await screen.findByText("Rovi needs an API key")).toBeInTheDocument();
  });

  it("surfaces a 422 (or any other) failure with a generic message rather than nothing", async () => {
    apiMock.mockRejectedValue(new ApiError("TRANSLATION_INVALID", "no strings", 422));
    await renderHarness(null, true);

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));

    expect(await screen.findByText(/couldn.t translate/i)).toBeInTheDocument();
  });

  it("surfaces a bare network failure (not an ApiError) too", async () => {
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderHarness(null, true);

    fireEvent.click(screen.getByRole("button", { name: "Translate" }));

    expect(await screen.findByText(/couldn.t translate/i)).toBeInTheDocument();
  });
});
