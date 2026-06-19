import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { UsagePage } from "../../src/routes/_authed/account/usage";

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

describe("<UsagePage />", () => {
  test("renders all three meter rows from the API", async () => {
    renderWithRouter(<UsagePage />, "/account/usage");

    await waitFor(() =>
      expect(screen.getByText("Monthly tracked revenue")).toBeInTheDocument(),
    );
    expect(screen.getByText("Events ingested")).toBeInTheDocument();
    expect(screen.getByText("SQL queries")).toBeInTheDocument();
  });

  test("unavailable meter shows the unavailable label instead of a numeric value", async () => {
    renderWithRouter(<UsagePage />, "/account/usage");

    await waitFor(() =>
      expect(screen.getByText("SQL queries")).toBeInTheDocument(),
    );

    // The MSW fixture sets sql_queries.available = false → should render "Unavailable"
    expect(screen.getByText("Unavailable")).toBeInTheDocument();

    // Confirm no raw "0" is rendered for the unavailable row (current is null,
    // so nothing numeric should appear in place of a value).
    const unavailableLabel = screen.getByText("Unavailable");
    const unavailableRow = unavailableLabel.closest('[class*="grid"]') ?? unavailableLabel.parentElement!;
    expect(unavailableRow.querySelector('[data-testid="usage-value"]')).toBeNull();
    // Broader guard: the "Unavailable" text should be present rather than "0 / …"
    expect(screen.queryByText(/^0\s*\/\s*/)).toBeNull();
  });
});
