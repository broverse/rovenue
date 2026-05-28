import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { RefundShieldSettingsPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/settings";

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

describe("<RefundShieldSettingsPage />", () => {
  test("renders the disabled default state", async () => {
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(screen.getByText(/refund shield settings/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/enable refund shield/i)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("submitting without consent shows the required hint", async () => {
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText(/enable refund shield/i),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/enable refund shield/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/tick the consent box before enabling/i),
      ).toBeInTheDocument(),
    );
  });

  test("PUT 400 from the server surfaces as a banner", async () => {
    server.use(
      http.put(
        `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
        () =>
          HttpResponse.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "consentAcknowledged: true is required",
              },
            },
            { status: 400 },
          ),
      ),
    );
    renderWithRouter(
      <RefundShieldSettingsPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/settings",
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText(/enable refund shield/i),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/enable refund shield/i));
    fireEvent.click(screen.getByLabelText(/i confirm our terms/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/consentAcknowledged: true is required/i),
      ).toBeInTheDocument(),
    );
  });
});
