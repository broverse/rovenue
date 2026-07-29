import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { LocalizedTextField } from "./fields";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";

// =============================================================
// LocalizedTextField — the Content-tab label input for
// text/button/purchaseButton nodes.
//
// BUG (both halves the same root cause): this field read
// `vm.config.localizations`/`vm.editLocale` directly via `useService`
// inside a PLAIN function component. impair's `useService` alone does not
// subscribe to anything — only a `component()`-wrapped body's synchronous
// execution is tracked (see `layer-tree.tsx`'s `LayerTree` for the
// established idiom). This field's only tracked ancestor was `ContentTab`
// (`component()`-wrapped, hence `React.memo`'d), which only re-renders when
// its `node` prop changes IDENTITY. `setLocaleText`/`setEditLocale` mutate
// `config.localizations`/`editLocale` — both SIBLINGS of `config.root`,
// never touched by either call — so the selected node's identity never
// changes and `ContentTab`'s memo bail-out skipped this subtree on every
// keystroke and every locale switch. Fixed by wrapping `LocalizedTextField`
// itself in `component()`, giving it an independent reactive effect.
//
// Uses the real VM behind `ServiceProvider` (not a hand-rolled mock) — this
// class of bug is invisible to a mock that just returns whatever the test
// hands it back; only the real reactive plumbing can reproduce it.
// =============================================================

const LOC_KEY = "k_cta";
const EN_TEXT = "Subscribe";
const FR_TEXT = "S'abonner";

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.localizations = { en: { [LOC_KEY]: EN_TEXT }, fr: { [LOC_KEY]: FR_TEXT } };
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

/** Mounts `LocalizedTextField` inside real DI, loaded from a fake config, and hands back the live VM. */
async function renderHarness() {
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
      <LocalizedTextField label="Label" locKey={LOC_KEY} />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

describe("LocalizedTextField — typing", () => {
  it("reflects what was typed (RED before the fix: React resets a stale controlled value on every keystroke)", async () => {
    const { vm } = await renderHarness();
    const input = screen.getByDisplayValue(EN_TEXT) as HTMLInputElement;

    // impair's `component()` schedules its re-render on a microtask (see
    // `fields.tsx`'s comment on why this field needs its OWN tracked
    // scope), so the DOM only reflects the write once that microtask has
    // been flushed — `act(async () => ...)` is what flushes it, matching
    // this codebase's own idiom (`layer-tree.test.tsx`) for asserting on a
    // `component()`-driven re-render rather than just the underlying model.
    await act(async () => {
      fireEvent.change(input, { target: { value: "Subscribe now" } });
    });

    expect(input.value).toBe("Subscribe now");
    expect(vm.config.localizations.en?.[LOC_KEY]).toBe("Subscribe now");
  });

  it("keeps committing keystroke after keystroke, not just the first one", async () => {
    const { vm } = await renderHarness();
    const input = screen.getByDisplayValue(EN_TEXT) as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: "S" } });
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Su" } });
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Sub" } });
    });

    expect(input.value).toBe("Sub");
    expect(vm.config.localizations.en?.[LOC_KEY]).toBe("Sub");
  });
});

describe("LocalizedTextField — locale switch", () => {
  it("shows the newly active locale's value after switching", async () => {
    const { vm } = await renderHarness();
    expect(screen.getByDisplayValue(EN_TEXT)).toBeTruthy();

    await act(async () => {
      vm.setEditLocale("fr");
    });

    expect(screen.getByDisplayValue(FR_TEXT)).toBeTruthy();
    expect(screen.queryByDisplayValue(EN_TEXT)).toBeNull();
  });
});

describe("LocalizedTextField — translation jump button", () => {
  it("opens the localization modal focused on this field's own key", async () => {
    const { vm } = await renderHarness();
    expect(vm.localizationFocusKey).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Edit translations"));
    });

    expect(vm.localizationFocusKey).toBe(LOC_KEY);
  });
});
