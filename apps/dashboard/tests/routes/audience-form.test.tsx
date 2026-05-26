import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { AudienceForm } from "../../src/components/audiences/audience-form";
import en from "../../src/i18n/locales/en.json";

const BASE = "http://localhost:3000";

beforeAll(() => {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("<AudienceForm /> create flow", () => {
  test("submits name + country condition as expected POST body", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${BASE}/dashboard/audiences`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          data: {
            audience: {
              id: "aud_new",
              projectId: "proj_1",
              name: "EU",
              description: null,
              rules: { country: { $in: ["DE", "FR"] } },
              isDefault: false,
              createdAt: "2026-05-26T00:00:00Z",
              updatedAt: "2026-05-26T00:00:00Z",
            },
          },
        });
      }),
    );

    renderWithRouter(
      <AudienceForm projectId="proj_1" />,
      "/projects/proj_1/audiences/new",
    );

    // Fill name
    const nameInput = await screen.findByPlaceholderText(/EU customers/i);
    fireEvent.change(nameInput, { target: { value: "EU" } });

    // Open the add-condition menu, pick Country
    fireEvent.click(screen.getByRole("button", { name: /Add condition/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Country$/i }));

    // The ChipInput is a free-text input; placeholder is visible when value list is empty.
    const chipInput = await screen.findByPlaceholderText(/TR, DE, US/);
    fireEvent.change(chipInput, { target: { value: "DE,FR" } });
    fireEvent.keyDown(chipInput, { key: "Enter" });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Create audience/i }));

    await waitFor(() => {
      expect(capturedBody).toEqual({
        projectId: "proj_1",
        name: "EU",
        rules: { country: { $in: ["DE", "FR"] } },
      });
    });
  });

  test("default audience renders read-only with banner", async () => {
    renderWithRouter(
      <AudienceForm
        projectId="proj_1"
        initialAudience={{
          id: "aud_default",
          projectId: "proj_1",
          name: "All Users",
          description: "Matches every subscriber",
          rules: {},
          isDefault: true,
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        }}
      />,
      "/projects/proj_1/audiences/aud_default",
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          /default audience matches every subscriber and cannot be edited/i,
        ),
      ).toBeInTheDocument();
    });

    // No submit button for the default audience.
    expect(
      screen.queryByRole("button", { name: /save changes/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create audience/i }),
    ).not.toBeInTheDocument();
  });
});
