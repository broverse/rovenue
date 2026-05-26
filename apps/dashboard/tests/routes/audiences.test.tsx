import { describe, expect, test, vi, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { AudiencesPage } from "../../src/routes/_authed/projects/$projectId/audiences/index";

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

describe("<AudiencesPage />", () => {
  test("renders the audiences from the API", async () => {
    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    // Use case-sensitive match: "All Users" (audience name) vs "all users" (rules cell)
    await waitFor(() =>
      expect(screen.getByText("All Users")).toBeInTheDocument(),
    );
    expect(screen.getByText("EU customers")).toBeInTheDocument();
  });

  test("default audience has no kebab menu", async () => {
    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    await waitFor(() =>
      expect(screen.getByText("EU customers")).toBeInTheDocument(),
    );
    // Only the EU customers row should have an action menu button.
    const menus = screen.getAllByRole("button", {
      name: /audience actions/i,
    });
    expect(menus).toHaveLength(1);
  });

  test("delete surfaces 409 'in use' error", async () => {
    server.use(
      http.delete(`${BASE}/dashboard/audiences/:id`, () =>
        HttpResponse.json(
          {
            error: {
              code: "CONFLICT",
              message: "Audience is in use by at least one experiment",
            },
          },
          { status: 409 },
        ),
      ),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    await waitFor(() =>
      expect(screen.getByText("EU customers")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /audience actions/i }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /^Delete$/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/in use by at least one experiment/i),
      ).toBeInTheDocument(),
    );
  });
});
