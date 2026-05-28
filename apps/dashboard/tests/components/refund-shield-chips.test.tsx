import { describe, expect, test, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { StatusChip } from "../../src/components/refund-shield/status-chip";
import { OutcomeChip } from "../../src/components/refund-shield/outcome-chip";

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

describe("StatusChip / OutcomeChip", () => {
  test("PENDING renders the pending label", () => {
    render(<StatusChip status="PENDING" />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  test("REFUND_DECLINED renders the declined label in success tone", () => {
    render(<OutcomeChip outcome="REFUND_DECLINED" />);
    expect(screen.getByText(/declined/i)).toBeInTheDocument();
  });

  test("OutcomeChip renders em-dash when outcome is null", () => {
    render(<OutcomeChip outcome={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
