import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { SubscriberRefundShieldCard } from "../../src/components/refund-shield/subscriber-tab";

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

describe("<SubscriberRefundShieldCard />", () => {
  test("disabled state surfaces the 'Refund Shield is off' notice", async () => {
    const { container } = renderWithRouter(
      <SubscriberRefundShieldCard projectId="proj_1" subscriberId="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("Refund Shield is off"),
    );
  });

  test("enabled + matching subscriber renders the count + chips", async () => {
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
      <SubscriberRefundShieldCard projectId="proj_1" subscriberId="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() =>
      expect(screen.getByText(/refund shield/i)).toBeInTheDocument(),
    );
    // sub_1 owns rss_sent_declined in the fixture
    await waitFor(() =>
      expect(screen.getByText(/2000000111111111/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/refund declined/i)).toBeInTheDocument();
  });

  test("enabled + no responses for the subscriber → empty state", async () => {
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
      <SubscriberRefundShieldCard
        projectId="proj_1"
        subscriberId="sub_999"
      />,
      "/projects/proj_1/subscribers/sub_999",
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no refund requests for this subscriber/i),
      ).toBeInTheDocument(),
    );
  });
});
