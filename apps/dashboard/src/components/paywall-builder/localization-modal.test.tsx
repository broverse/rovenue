import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../i18n/config";
import { LocalizationModal } from "./localization-modal";
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

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({ type: "text", id: "t_a", key: KEY_A, role: "title" } as TextNode);
  config.root.children.push({ type: "text", id: "t_b", key: KEY_B, role: "body" } as TextNode);
  config.localizations = {
    en: { [KEY_A]: "Hello", [KEY_B]: "World" },
  };
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

async function renderHarness(focusKey?: string | null) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail());

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
