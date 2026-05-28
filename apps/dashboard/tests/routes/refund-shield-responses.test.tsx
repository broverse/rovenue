import { describe, expect, test, beforeAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { RefundShieldResponsesPage } from "../../src/routes/_authed/projects/$projectId/refund-shield/responses";

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

describe("<RefundShieldResponsesPage />", () => {
  test("renders all rows from the fixture and shows status chips", async () => {
    renderWithRouter(
      <RefundShieldResponsesPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/responses",
    );
    await waitFor(() =>
      expect(screen.getByText(/2000000111111111/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/2000000222222221/)).toBeInTheDocument();
    expect(screen.getByText(/2000000333333331/)).toBeInTheDocument();
    expect(screen.getByText(/2000000444444441/)).toBeInTheDocument();

    // Status chip text appears in both the filter dropdown and the table row.
    // We only assert that they exist somewhere in the rendered DOM.
    expect(screen.getAllByText(/^sent$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^pending$/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/skipped \(disabled\)/i).length,
    ).toBeGreaterThan(0);
  });

  test("filtering by status=PENDING narrows the table", async () => {
    renderWithRouter(
      <RefundShieldResponsesPage projectId="proj_1" />,
      "/projects/proj_1/refund-shield/responses",
    );
    await waitFor(() =>
      expect(screen.getByText(/2000000222222221/)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/^status$/i), {
      target: { value: "PENDING" },
    });
    await waitFor(() => {
      expect(screen.queryByText(/2000000444444441/)).not.toBeInTheDocument();
      expect(screen.getByText(/2000000222222221/)).toBeInTheDocument();
    });
  });
});
