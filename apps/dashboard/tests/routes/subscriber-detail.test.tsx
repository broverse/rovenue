import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { SubscriberDetailPage } from "../../src/routes/_authed/projects/$projectId/subscribers/$id";

const BASE = "http://localhost:3000";

// The page grew two fetches after this test was written — the project's
// access list and the subscriber's credit history — and neither is in the
// shared handler set (tests/msw/handlers.ts), which still only covers
// `/subscribers/:id`. `tests/setup.ts` runs MSW with
// `onUnhandledRequest: "error"`, so both queries failed and the page never
// rendered its entitlement or balance.
//
// Shapes come from the real contracts: `DashboardAccessListResponse` is
// `{ rows }` and `CreditHistoryResponse` is `{ entries, nextCursor }`
// (packages/shared/src/dashboard.ts), both inside the `{ data }` envelope
// that `api()` unwraps.
beforeEach(() => {
  server.use(
    // The mocked subscriber (tests/msw/handlers.ts) holds an access grant
    // keyed by `accessId`, and the page resolves that id to a human
    // identifier through this list — so an empty list renders no
    // entitlement name at all, which is what "premium" not being found
    // was really telling us.
    http.get(`${BASE}/dashboard/projects/:projectId/access`, () =>
      HttpResponse.json({
        data: {
          rows: [
            {
              id: "acs_demo_premium000000000",
              identifier: "premium",
              displayName: "Premium",
              description: null,
              productCount: 1,
              metadata: {},
              createdAt: "2026-04-01T00:00:00Z",
              updatedAt: "2026-04-01T00:00:00Z",
            },
          ],
        },
      }),
    ),
    http.get(
      `${BASE}/dashboard/projects/:projectId/subscribers/:id/credit-history`,
      () => HttpResponse.json({ data: { entries: [], nextCursor: null } }),
    ),
  );
});

describe("<SubscriberDetailPage />", () => {
  test("renders appUserId, balance, and the premium entitlement", async () => {
    renderWithRouter(
      <SubscriberDetailPage projectId="proj_1" id="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("42")).toBeInTheDocument();

    // AccessTable maps accessId -> displayName and falls back to the raw id
    // (`labelById.get(r.accessId) ?? r.accessId`). The access list is a
    // SEPARATE query from the subscriber, so the row first paints with the
    // raw id and only becomes the label once that query lands — `getByText`
    // here raced it and saw the fallback. Await the label, then assert the
    // raw id is gone: the label alone would still pass if the lookup broke
    // and the id merely happened to contain the word.
    expect(await screen.findByText("Premium")).toBeInTheDocument();
    expect(screen.queryByText("acs_demo_premium000000000")).toBeNull();
  });
});
