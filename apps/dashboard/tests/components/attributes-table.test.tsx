import { describe, expect, test, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { AttributesTable } from "../../src/components/subscribers/AttributesTable";

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

describe("AttributesTable", () => {
  test("renders one row per attribute with value + source", () => {
    render(
      <AttributesTable
        attributes={{
          $email: {
            value: "a@b.com",
            updatedAt: "2026-06-15T10:00:00.000Z",
            source: "sdk",
          },
          favoriteTeam: {
            value: "GS",
            updatedAt: "2026-06-15T10:00:00.000Z",
            source: "dashboard",
          },
        }}
      />,
    );
    expect(screen.getByText("$email")).toBeInTheDocument();
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect(screen.getByText("GS")).toBeInTheDocument();
    expect(screen.getByText("sdk")).toBeInTheDocument();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  test("renders empty state when no attributes", () => {
    render(<AttributesTable attributes={{}} />);
    expect(screen.getByText("No attributes")).toBeInTheDocument();
  });
});
