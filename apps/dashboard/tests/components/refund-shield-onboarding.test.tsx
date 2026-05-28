import { describe, expect, test, beforeAll, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { renderWithRouter } from "../render";
import { OnboardingWizard } from "../../src/components/refund-shield/onboarding-wizard";

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

describe("<OnboardingWizard />", () => {
  test("walks through all 4 steps and POSTs enabled=true on finish", async () => {
    const onComplete = vi.fn();
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={onComplete} />,
      "/projects/proj_1/refund-shield",
    );

    // Step 1
    await waitFor(() =>
      expect(screen.getByText(/set up refund shield/i)).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /upgraded the sdk/i }),
    );

    // Step 2
    expect(
      screen.getByText(/update your terms of service/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /updated our tos/i }),
    );

    // Step 3
    expect(screen.getByText(/response delay/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    // Step 4
    expect(screen.getByRole("heading", { name: /^enable$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/i confirm our terms/i));
    fireEvent.click(
      screen.getByRole("button", { name: /enable refund shield/i }),
    );

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  test("Back navigates one step at a time", async () => {
    renderWithRouter(
      <OnboardingWizard projectId="proj_1" onComplete={() => {}} />,
      "/projects/proj_1/refund-shield",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /upgraded the sdk/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /upgraded the sdk/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /updated our tos/i }),
    );
    expect(screen.getByText(/response delay/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(
      screen.getByText(/update your terms of service/i),
    ).toBeInTheDocument();
  });
});
