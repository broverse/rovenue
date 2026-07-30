import { describe, expect, test, beforeAll, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { OnboardingWizard } from "../../src/components/refund-shield/onboarding-wizard";

const BASE = "http://localhost:3000";

// The wizard reads two endpoints, and neither was mocked. `tests/setup.ts`
// runs MSW with `onUnhandledRequest: "error"`, so both requests failed:
//
//  - GET …/credentials gates the whole checklist. The wizard renders a
//    spinner while it is loading and, when `apple.configured` is false,
//    routes the operator to connect Apple first instead of showing the
//    steps — which is why every step-1 button was missing.
//  - PUT …/refund-shield/settings is what `onComplete` waits on.
//
// Both shapes come from the real routes: the credentials list returns
// `ok({ credentials: { apple, google } })` and the settings PUT returns
// `ok({ settings })`, so after `api()` unwraps the envelope the hooks read
// `.credentials` and `.settings` respectively.

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

beforeEach(() => {
  server.use(
    http.get(`${BASE}/dashboard/projects/:projectId/credentials`, () =>
      HttpResponse.json({
        data: {
          credentials: {
            apple: { configured: true, safeFields: {} },
            google: { configured: false, safeFields: {} },
          },
        },
      }),
    ),
    http.put(`${BASE}/dashboard/projects/:projectId/refund-shield/settings`, () =>
      HttpResponse.json({
        data: {
          settings: {
            enabled: true,
            responseDelayMinutes: 60,
            consentAcknowledgedAt: "2026-07-30T00:00:00Z",
            consentAcknowledgedBy: "user_1",
          },
        },
      }),
    ),
  );
});

// These two tests previously walked a four-step wizard with SDK/ToS
// acknowledgement buttons and Back navigation. Commit e2d93e4d
// ("simplify onboarding to single card + gate on Apple connection")
// deliberately replaced all of it with one card, and the tests were never
// updated — they asserted a UI that no longer exists. Rewritten against
// what the component actually does now: gate on Apple, then consent, then
// enable.
describe("<OnboardingWizard />", () => {
  test("enables Refund Shield once consent is given, and calls onComplete", async () => {
    const onComplete = vi.fn();
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={onComplete} />,
      "/projects/proj_1/refund-shield",
    );

    const enableBtn = await screen.findByRole("button", {
      name: /enable refund shield/i,
    });

    // Consent gates the button — this is the guard worth pinning, since
    // enabling without it would ship consumption data to Apple on a
    // project whose ToS may not disclose it.
    expect((enableBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/i confirm our terms/i));
    expect((enableBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(enableBtn);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  test("sends the operator to connect Apple when no App Store credential exists", async () => {
    server.use(
      http.get(`${BASE}/dashboard/projects/:projectId/credentials`, () =>
        HttpResponse.json({
          data: {
            credentials: {
              apple: { configured: false, safeFields: {} },
              google: { configured: false, safeFields: {} },
            },
          },
        }),
      ),
    );

    const onComplete = vi.fn();
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={onComplete} />,
      "/projects/proj_1/refund-shield",
    );

    // Refund Shield only acts on Apple refund requests, so without an
    // App Store connection the consent form must not be reachable at all.
    expect(
      await screen.findByText(/connect your app store account first/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /enable refund shield/i }),
    ).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
