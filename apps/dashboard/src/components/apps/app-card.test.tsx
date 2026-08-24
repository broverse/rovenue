import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../../tests/render";
import { AppCard, MAX_WEBHOOK_ENDPOINTS_PER_PROJECT } from "./app-card";
import { CUSTOM_WEBHOOK_APP_ID } from "./mock-data";
import type { AppDescriptor } from "./types";
import type { IntegrationConnectionRow } from "../../lib/hooks/useProjectIntegrations";

const META_CAPI_APP: AppDescriptor = {
  id: "meta-capi",
  category: "ads",
  vendorKey: "meta",
  logo: { background: "#1877F2", glyph: "M" },
  status: "available",
};

const SNAPCHAT_UNAVAILABLE_APP: AppDescriptor = {
  id: "snapchat-ads",
  category: "ads",
  vendorKey: "snap",
  logo: { background: "#FFFC00", glyph: "S", textColor: "#000" },
  // "unavailable" is not in AppStatus union but the guard checks !== "unavailable"
  status: "unavailable" as AppDescriptor["status"],
};

describe("AppCard — M6.11", () => {
  it("clicking meta-capi card calls onOpenIntegration with 'meta-capi'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();

    const { container } = renderWithRouter(
      <AppCard
        app={META_CAPI_APP}
        onOpenIntegration={onOpenIntegration}
      />,
    );

    // Wait for component to render (the article element)
    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("meta-capi");
  });

  it("clicking amplitude card calls onOpenIntegration with 'amplitude'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();
    const AMPLITUDE_APP: AppDescriptor = {
      id: "amplitude",
      category: "analytics",
      vendorKey: "amplitude",
      logo: { background: "#0148FE", glyph: "A" },
      status: "available",
    };

    const { container } = renderWithRouter(
      <AppCard app={AMPLITUDE_APP} onOpenIntegration={onOpenIntegration} />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("amplitude");
  });

  it("clicking mixpanel card calls onOpenIntegration with 'mixpanel'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();
    const MIXPANEL_APP: AppDescriptor = {
      id: "mixpanel",
      category: "analytics",
      vendorKey: "mixpanel",
      logo: { background: "#7856FF", glyph: "M" },
      status: "available",
    };

    const { container } = renderWithRouter(
      <AppCard app={MIXPANEL_APP} onOpenIntegration={onOpenIntegration} />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("mixpanel");
  });

  it("clicking appsflyer card calls onOpenIntegration with 'appsflyer'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();
    const APPSFLYER_APP: AppDescriptor = {
      id: "appsflyer",
      category: "attribution",
      vendorKey: "appsflyer",
      logo: { background: "#0F1F41", glyph: "AF" },
      status: "available",
    };

    const { container } = renderWithRouter(
      <AppCard app={APPSFLYER_APP} onOpenIntegration={onOpenIntegration} />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("appsflyer");
  });

  it("clicking adjust card calls onOpenIntegration with 'adjust'", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();
    const ADJUST_APP: AppDescriptor = {
      id: "adjust",
      category: "attribution",
      vendorKey: "adjust",
      logo: { background: "#EC1C50", glyph: "AJ" },
      status: "available",
    };

    const { container } = renderWithRouter(
      <AppCard app={ADJUST_APP} onOpenIntegration={onOpenIntegration} />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).toHaveBeenCalledOnce();
    expect(onOpenIntegration).toHaveBeenCalledWith("adjust");
  });

  it("clicking unavailable snapchat-ads card does NOT call onOpenIntegration", async () => {
    const user = userEvent.setup();
    const onOpenIntegration = vi.fn();

    const { container } = renderWithRouter(
      <AppCard
        app={SNAPCHAT_UNAVAILABLE_APP}
        onOpenIntegration={onOpenIntegration}
      />,
    );

    await waitFor(() => {
      const article = container.querySelector("article");
      expect(article).toBeTruthy();
    });

    // The unavailable card's article has no onClick, so clicking it should not trigger
    const article = container.querySelector("article")!;
    await user.click(article);

    expect(onOpenIntegration).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 12 — multi-connection CUSTOM_WEBHOOK card
// ---------------------------------------------------------------------------

const CUSTOM_WEBHOOK_APP: AppDescriptor = {
  id: CUSTOM_WEBHOOK_APP_ID,
  category: "automation",
  vendorKey: "rovenue",
  logo: { background: "#6D28D9", glyph: "W" },
  status: "available",
};

function makeConnection(overrides: Partial<IntegrationConnectionRow> = {}): IntegrationConnectionRow {
  return {
    id: "wh1",
    providerId: "CUSTOM_WEBHOOK",
    displayName: "api.example.com",
    credentialsHint: "api.example.com · …abcd",
    enabledEvents: [],
    eventMapping: {},
    actionSource: "app",
    testEventCode: null,
    isEnabled: true,
    lastValidatedAt: null,
    lastError: null,
    lastBackfillAt: null,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    ...overrides,
  };
}

describe("AppCard — CUSTOM_WEBHOOK multi-connection", () => {
  it("lists every connection's name, credentialsHint, and enabled badge, with a per-row Edit action", async () => {
    const onEditConnection = vi.fn();
    const enabledConn = makeConnection({ id: "wh1", displayName: "prod.example.com", isEnabled: true });
    const disabledConn = makeConnection({
      id: "wh2",
      displayName: "staging.example.com",
      credentialsHint: "staging.example.com · …ef01",
      isEnabled: false,
    });

    renderWithRouter(
      <AppCard
        app={CUSTOM_WEBHOOK_APP}
        webhook={{
          connections: [enabledConn, disabledConn],
          onAddEndpoint: vi.fn(),
          onEditConnection,
        }}
      />,
    );

    expect(await screen.findByText("prod.example.com")).toBeTruthy();
    expect(screen.getByText("staging.example.com")).toBeTruthy();
    expect(screen.getByText("api.example.com · …abcd")).toBeTruthy();
    expect(screen.getByText("staging.example.com · …ef01")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /edit prod\.example\.com/i }));
    expect(onEditConnection).toHaveBeenCalledWith(enabledConn);
  });

  it("shows an empty-state message with zero connections", async () => {
    renderWithRouter(
      <AppCard
        app={CUSTOM_WEBHOOK_APP}
        webhook={{ connections: [], onAddEndpoint: vi.fn(), onEditConnection: vi.fn() }}
      />,
    );

    expect(await screen.findByText(/no endpoints configured/i)).toBeTruthy();
  });

  it("Add endpoint is enabled below the cap and calls onAddEndpoint", async () => {
    const user = userEvent.setup();
    const onAddEndpoint = vi.fn();

    renderWithRouter(
      <AppCard
        app={CUSTOM_WEBHOOK_APP}
        webhook={{ connections: [makeConnection()], onAddEndpoint, onEditConnection: vi.fn() }}
      />,
    );

    const addBtn = await screen.findByRole("button", { name: /add endpoint/i });
    expect((addBtn as HTMLButtonElement).disabled).toBe(false);
    await user.click(addBtn);
    expect(onAddEndpoint).toHaveBeenCalled();
  });

  it("Add endpoint is disabled with a tooltip at the cap", async () => {
    const atCapConnections = Array.from({ length: MAX_WEBHOOK_ENDPOINTS_PER_PROJECT }, (_, i) =>
      makeConnection({ id: `wh${i}`, displayName: `endpoint-${i}.example.com` }),
    );

    renderWithRouter(
      <AppCard
        app={CUSTOM_WEBHOOK_APP}
        webhook={{ connections: atCapConnections, onAddEndpoint: vi.fn(), onEditConnection: vi.fn() }}
      />,
    );

    const addBtn = await screen.findByRole("button", { name: /add endpoint/i });
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);
    expect(addBtn.getAttribute("title")).toMatch(new RegExp(String(MAX_WEBHOOK_ENDPOINTS_PER_PROJECT)));
  });
});
