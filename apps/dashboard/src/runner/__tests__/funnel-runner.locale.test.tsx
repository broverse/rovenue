import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../runner-api", () => ({
  getPublishedFunnel: vi.fn(),
  startSession: vi.fn(),
  advanceSession: vi.fn(),
  claimToken: vi.fn(),
  getSessionState: vi.fn(),
  submitAnswer: vi.fn(),
  RunnerApiError: class RunnerApiError extends Error {
    code = "ERR";
    status = 500;
    constructor(code: string, message: string, status = 500) {
      super(message);
      this.name = "RunnerApiError";
      this.code = code;
      this.status = status;
    }
  },
}));

import { FunnelRunner } from "../funnel-runner";
import * as api from "../runner-api";

const baseTheme = {
  primary: "#000",
  accent: "#000",
  bg: "#fff",
  text: "#000",
  font: "system-ui",
  logoUrl: "",
  logoLetter: "",
  progressStyle: "solid" as const,
  progressActive: "",
  progressInactive: "rgba(0,0,0,0.1)",
  backIcon: "chevron" as const,
  radius: 10,
};

const baseConfig = {
  id: "f1",
  slug: "demo",
  version_id: "v1",
  settings: {},
  defaultLocale: "en",
  locales: ["en", "tr"],
  theme: baseTheme,
  pages: [
    {
      id: "p1",
      type: "welcome",
      title: { en: "Hello", tr: "Merhaba" },
      cta: { en: "Continue", tr: "Devam" },
    },
  ],
};

beforeEach(() => {
  vi.mocked(api.getPublishedFunnel).mockResolvedValue(baseConfig as never);
  vi.mocked(api.startSession).mockResolvedValue({
    session_id: "s1",
    first_page_id: "p1",
  } as never);
});

describe("FunnelRunner locale", () => {
  it("renders the TR title when ?lng=tr", async () => {
    window.history.replaceState({}, "", "/?lng=tr");
    render(<FunnelRunner slug="demo" />);
    // Title appears in both the page-chrome h1 and the WelcomeBody h2 — both should show the resolved locale.
    await waitFor(() =>
      expect(screen.getAllByText("Merhaba").length).toBeGreaterThan(0),
    );
  });

  it("falls back to defaultLocale when ?lng= isn't in funnel.locales", async () => {
    window.history.replaceState({}, "", "/?lng=zz");
    render(<FunnelRunner slug="demo" />);
    await waitFor(() =>
      expect(screen.getAllByText("Hello").length).toBeGreaterThan(0),
    );
  });

  it("resolves region fallback (pt-BR → pt) when only the primary tag is authored", async () => {
    vi.mocked(api.getPublishedFunnel).mockResolvedValue({
      ...baseConfig,
      locales: ["en", "pt"],
      pages: [
        {
          id: "p1",
          type: "welcome",
          title: { en: "Hello", pt: "Olá" },
          cta: { en: "Continue", pt: "Continuar" },
        },
      ],
    } as never);
    window.history.replaceState({}, "", "/?lng=pt-BR");
    render(<FunnelRunner slug="demo" />);
    await waitFor(() =>
      expect(screen.getAllByText("Olá").length).toBeGreaterThan(0),
    );
  });
});
