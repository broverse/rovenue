import { describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { LeaderboardsPage } from "../../src/routes/_authed/projects/$projectId/leaderboards";

const BASE = "http://localhost:3000";
const PROJECT_ID = "proj_1";
const ROOT = `${BASE}/dashboard/projects/${PROJECT_ID}/leaderboards`;

function noCurrencies() {
  return http.get(
    `${BASE}/dashboard/projects/${PROJECT_ID}/virtual-currencies`,
    () => HttpResponse.json({ data: { currencies: [] } }),
  );
}

interface AdHocOpts {
  spenders?: Array<{ subscriberId: string; totalUsd: string; eventCount: number }>;
  consumers?: Array<{ subscriberId: string; totalUsd: string; eventCount: number }>;
}

function adHocHandlers(opts: AdHocOpts = {}) {
  return [
    http.get(`${ROOT}/top-spenders`, () =>
      HttpResponse.json({
        data: { from: "2026-08-01", to: "2026-09-01", entries: opts.spenders ?? [] },
      }),
    ),
    http.get(`${ROOT}/top-consumers`, () =>
      HttpResponse.json({
        data: { from: "2026-08-01", to: "2026-09-01", entries: opts.consumers ?? [] },
      }),
    ),
  ];
}

function configuredLeaderboard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "lb_1",
    projectId: PROJECT_ID,
    identifier: "weekly-top-spenders",
    name: "Weekly Top Spenders",
    metric: "TOP_SPENDERS",
    currencyId: null,
    cadence: "WEEKLY",
    customPeriodDays: null,
    timezone: "UTC",
    entryLimit: 10,
    anchorAt: "2026-01-01T00:00:00.000Z",
    isEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("<LeaderboardsPage />", () => {
  test("renders configured leaderboards alongside the ad-hoc range view", async () => {
    server.use(
      noCurrencies(),
      ...adHocHandlers({
        spenders: [{ subscriberId: "sub_adhoc", totalUsd: "12.50", eventCount: 3 }],
      }),
      http.get(ROOT, () =>
        HttpResponse.json({ data: { leaderboards: [configuredLeaderboard()] } }),
      ),
    );

    renderWithRouter(
      <LeaderboardsPage projectId={PROJECT_ID} />,
      "/projects/proj_1/leaderboards",
    );

    // The configured leaderboard renders.
    await waitFor(() =>
      expect(screen.getByText("Weekly Top Spenders")).toBeInTheDocument(),
    );

    // The pre-existing ad-hoc range view is untouched: its tabs and data
    // still render exactly as before this task.
    expect(screen.getByRole("tab", { name: /top spenders/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /top consumers/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("sub_adhoc")).toBeInTheDocument(),
    );
    expect(screen.getByText("$12.50")).toBeInTheDocument();
  });

  test("shows an empty state when a leaderboard's first season has not closed", async () => {
    const lb = configuredLeaderboard();
    server.use(
      noCurrencies(),
      ...adHocHandlers(),
      http.get(ROOT, () => HttpResponse.json({ data: { leaderboards: [lb] } })),
      http.get(`${ROOT}/${lb.id}/seasons`, () =>
        HttpResponse.json({ data: { seasons: [] } }),
      ),
      http.get(`${ROOT}/${lb.id}/current`, () =>
        HttpResponse.json({ data: { season: null, entries: [] } }),
      ),
    );

    renderWithRouter(
      <LeaderboardsPage projectId={PROJECT_ID} />,
      "/projects/proj_1/leaderboards",
    );

    await waitFor(() =>
      expect(screen.getByText("Weekly Top Spenders")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view weekly top spenders standings/i }),
    );

    // Empty state, not an error.
    await waitFor(() =>
      expect(
        screen.getByText(/no season has opened for this leaderboard yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("switching to a past season fetches the frozen standings", async () => {
    const lb = configuredLeaderboard();
    const activeSeason = {
      id: "season_2",
      leaderboardId: lb.id,
      seasonNumber: 2,
      startsAt: "2026-08-25T00:00:00.000Z",
      endsAt: "2026-09-01T00:00:00.000Z",
      status: "ACTIVE",
      closedAt: null,
      createdAt: "2026-08-25T00:00:00.000Z",
    };
    const closedSeason = {
      id: "season_1",
      leaderboardId: lb.id,
      seasonNumber: 1,
      startsAt: "2026-08-18T00:00:00.000Z",
      endsAt: "2026-08-25T00:00:00.000Z",
      status: "CLOSED",
      closedAt: "2026-08-25T00:00:00.000Z",
      createdAt: "2026-08-18T00:00:00.000Z",
    };

    let currentCalls = 0;
    let standingsCalls = 0;

    server.use(
      noCurrencies(),
      ...adHocHandlers(),
      http.get(ROOT, () => HttpResponse.json({ data: { leaderboards: [lb] } })),
      http.get(`${ROOT}/${lb.id}/seasons`, () =>
        HttpResponse.json({ data: { seasons: [activeSeason, closedSeason] } }),
      ),
      http.get(`${ROOT}/${lb.id}/current`, () => {
        currentCalls += 1;
        return HttpResponse.json({
          data: {
            season: activeSeason,
            entries: [{ subscriberId: "sub_live", score: "100.00", eventCount: 2 }],
          },
        });
      }),
      http.get(`${ROOT}/seasons/:seasonId/standings`, ({ params }) => {
        expect(params.seasonId).toBe(closedSeason.id);
        standingsCalls += 1;
        return HttpResponse.json({
          data: {
            season: closedSeason,
            standings: [
              {
                id: "st_1",
                seasonId: closedSeason.id,
                rank: 1,
                subscriberId: "sub_frozen",
                score: "250.00",
                eventCount: 9,
              },
            ],
          },
        });
      }),
    );

    renderWithRouter(
      <LeaderboardsPage projectId={PROJECT_ID} />,
      "/projects/proj_1/leaderboards",
    );

    await waitFor(() =>
      expect(screen.getByText("Weekly Top Spenders")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /view weekly top spenders standings/i }),
    );

    await waitFor(() => expect(screen.getByText("sub_live")).toBeInTheDocument());
    expect(currentCalls).toBe(1);
    expect(standingsCalls).toBe(0);

    fireEvent.click(screen.getByRole("tab", { name: /season 1/i }));

    await waitFor(() => expect(screen.getByText("sub_frozen")).toBeInTheDocument());
    expect(standingsCalls).toBe(1);
    // Switching to a past season must not re-hit /current.
    expect(currentCalls).toBe(1);
    expect(screen.queryByText("sub_live")).not.toBeInTheDocument();
  });

  test("customPeriodDays is only shown for the CUSTOM cadence", async () => {
    server.use(
      noCurrencies(),
      ...adHocHandlers(),
      http.get(ROOT, () => HttpResponse.json({ data: { leaderboards: [] } })),
    );

    renderWithRouter(
      <LeaderboardsPage projectId={PROJECT_ID} />,
      "/projects/proj_1/leaderboards",
    );

    await waitFor(() =>
      expect(screen.getByText(/no leaderboards configured yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^new leaderboard$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/custom period/i)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^identifier$/i), {
      target: { value: "custom-board" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^name$/i), {
      target: { value: "Custom board" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^cadence$/i), {
      target: { value: "CUSTOM" },
    });

    const customPeriodInput = within(dialog).getByLabelText(/custom period/i);
    expect(customPeriodInput).toBeInTheDocument();

    const submit = within(dialog).getByRole("button", {
      name: /create leaderboard/i,
    });
    expect(submit).toBeDisabled();

    fireEvent.change(customPeriodInput, { target: { value: "14" } });
    expect(submit).not.toBeDisabled();
  });
});
