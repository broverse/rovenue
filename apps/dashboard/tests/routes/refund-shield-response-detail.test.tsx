import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { RefundShieldResponseDetailPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/responses_.$rid";

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

describe("<RefundShieldResponseDetailPage />", () => {
  test("renders timeline, payload, and subscriber link", async () => {
    renderWithRouter(
      <RefundShieldResponseDetailPage
        projectId="proj_1"
        rid="rss_sent_declined"
      />,
      "/projects/proj_1/refund-shield/responses/rss_sent_declined",
    );
    await waitFor(() =>
      expect(screen.getByText(/posted to apple/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/refund declined/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/2000000111111112/i).length,
    ).toBeGreaterThan(0);
    // Apple payload JSON visible
    expect(screen.getByText(/customerConsented/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /view subscriber/i }),
    ).toBeInTheDocument();
  });

  test("rss_pending: timeline stops at scheduled, no Apple response", async () => {
    renderWithRouter(
      <RefundShieldResponseDetailPage projectId="proj_1" rid="rss_pending" />,
      "/projects/proj_1/refund-shield/responses/rss_pending",
    );
    await waitFor(() =>
      expect(screen.getByText(/scheduled to send/i)).toBeInTheDocument(),
    );
    // No "Posted to Apple" event for pending rows.
    expect(screen.queryByText(/posted to apple/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no payload/i)).toBeInTheDocument();
  });
});
