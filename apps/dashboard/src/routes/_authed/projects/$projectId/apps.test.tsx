import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../../../../tests/render";
import { AppsPage, CARD_ID_TO_PROVIDER } from "./apps";
import { DRAWER_IDS } from "../../../../components/apps/app-card";
import type { IntegrationConnectionRow } from "../../../../lib/hooks/useProjectIntegrations";

// =============================================================
// Review-fix regression test — applyWebhookStatus isEnabled gate
// =============================================================
//
// Before this fix, the CUSTOM_WEBHOOK catalog card showed "Connected" as
// soon as a project had ANY webhook endpoint row, regardless of whether
// that endpoint was actually enabled — inconsistent with every other
// provider's status derivation (apps/api/src/services/apps-connections.ts
// gates on `conn.isEnabled`). A project with only disabled endpoints would
// misleadingly appear in the "Your connected apps" strip.
//
// Hooks are module-mocked so this exercises only AppsPage's own status
// aggregation (applyWebhookStatus), not a full page's worth of network
// traffic — same rationale as charts.test.tsx's dispatch-regression test.

const useProject = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/hooks/useProject", () => ({ useProject }));

const useProjectAppConnections = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/hooks/useProjectAppConnections", () => ({
  useProjectAppConnections,
}));

const useProjectIntegrations = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/hooks/useProjectIntegrations", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/hooks/useProjectIntegrations")>(
    "../../../../lib/hooks/useProjectIntegrations",
  );
  return { ...actual, useProjectIntegrations };
});

function webhookConnection(overrides: Partial<IntegrationConnectionRow>): IntegrationConnectionRow {
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

function arrange(connections: IntegrationConnectionRow[]) {
  useProject.mockReturnValue({
    data: {
      id: "proj_1",
      webhookUrl: null,
      webhookEventCategories: [],
      hasWebhookSecret: false,
    },
  });
  useProjectAppConnections.mockReturnValue({ data: { connections: [] } });
  useProjectIntegrations.mockReturnValue({ data: connections });
  return renderWithRouter(<AppsPage projectId="proj_1" />, "/projects/proj_1/apps");
}

describe("AppsPage — CUSTOM_WEBHOOK connected status", () => {
  it("does NOT show the webhook card as connected when every endpoint is disabled", async () => {
    arrange([webhookConnection({ isEnabled: false })]);

    // The "Your connected apps" strip only renders when at least one app
    // has status "connected" — asserting its absence is a real check on
    // the rendered status, not on applyWebhookStatus's return value.
    await screen.findByText(/apps & integrations/i); // page has rendered
    expect(screen.queryByText(/your connected apps/i)).toBeNull();
  });

  it("shows the webhook card as connected once at least one endpoint is enabled", async () => {
    arrange([
      webhookConnection({ id: "wh1", isEnabled: false }),
      webhookConnection({ id: "wh2", isEnabled: true }),
    ]);

    expect(await screen.findByText(/your connected apps/i)).toBeInTheDocument();
  });
});

// =============================================================
// Drawer routing invariant — CARD_ID_TO_PROVIDER ↔ DRAWER_IDS
// =============================================================
//
// Regression guard for the inert SLACK card: the provider had a complete
// backend, drawer steps and catalog entry, and was listed here, but was
// missing from app-card.tsx's DRAWER_IDS — the only thing that makes a card
// clickable — so it could never be connected from the dashboard. Neither
// side's own tests could see the mismatch; this one does.
describe("AppsPage — drawer routing coverage", () => {
  it("CARD_ID_TO_PROVIDER and DRAWER_IDS cover exactly the same card ids", () => {
    expect(new Set(Object.keys(CARD_ID_TO_PROVIDER))).toEqual(new Set(DRAWER_IDS));
  });
});
