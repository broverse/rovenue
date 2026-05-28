import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { RefundShieldOverviewPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/index";

const BASE = "http://localhost:3000";

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

describe("<RefundShieldOverviewPage />", () => {
  test("disabled state shows the onboarding wizard", async () => {
    renderWithRouter(
      <RefundShieldOverviewPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield",
    );
    await waitFor(() =>
      expect(screen.getByText(/set up refund shield/i)).toBeInTheDocument(),
    );
  });

  test("enabled state renders KPI cards and breakdown", async () => {
    server.use(
      http.get(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json({
            data: {
              settings: {
                enabled: true,
                responseDelayMinutes: 60,
                consentAcknowledgedAt: "2026-05-01T00:00:00.000Z",
                consentAcknowledgedBy: "u1",
              },
            },
          }),
      ),
    );
    renderWithRouter(
      <RefundShieldOverviewPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield",
    );
    await waitFor(() =>
      expect(screen.getByText(/^responses sent$/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("184")).toBeInTheDocument();
    expect(screen.getByText(/74\.7%/)).toBeInTheDocument();
    expect(screen.getByText(/\$4,824\.00/)).toBeInTheDocument();
    expect(screen.getByText(/^declined$/i)).toBeInTheDocument();
    expect(screen.getByText(/^approved$/i)).toBeInTheDocument();
    expect(screen.getByText(/^reversed$/i)).toBeInTheDocument();
  });
});
