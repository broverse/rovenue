import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepDeliveries } from "./step-deliveries";
import type { IntegrationDeliveryRow } from "../../../lib/hooks/useProjectIntegrations";

const DELIVERY_SUCCEEDED: IntegrationDeliveryRow = {
  id: "d1",
  connectionId: "c1",
  outboxEventId: "oe1",
  eventKey: "revenue.RENEWAL",
  providerEvent: "Purchase",
  status: "succeeded",
  attempt: 1,
  httpStatus: 200,
  responseBody: null,
  errorMessage: null,
  skipReason: null,
  createdAt: "2026-05-28T10:00:00Z",
};

const DELIVERY_DEAD_LETTER: IntegrationDeliveryRow = {
  id: "d2",
  connectionId: "c1",
  outboxEventId: "oe2",
  eventKey: "revenue.INITIAL_BUY",
  providerEvent: null,
  status: "dead_letter",
  attempt: 5,
  httpStatus: 500,
  responseBody: null,
  errorMessage: "Internal Server Error",
  skipReason: null,
  createdAt: "2026-05-28T09:00:00Z",
};

const DELIVERY_FAILED: IntegrationDeliveryRow = {
  id: "d3",
  connectionId: "c1",
  outboxEventId: "oe3",
  eventKey: "revenue.REFUND",
  providerEvent: null,
  status: "failed",
  attempt: 2,
  httpStatus: 500,
  responseBody: null,
  errorMessage: "Internal Server Error",
  skipReason: null,
  createdAt: "2026-05-28T08:00:00Z",
};

// Final-review I5: identity-gated providers (APPSFLYER without a usable
// platform app id, AMPLITUDE/MIXPANEL without a resolvable user id, …) skip
// routinely, and appsflyer.mdx tells operators the reason is "visible in the
// connection's Delivery Log". It was not rendered anywhere before this fix.
const DELIVERY_SKIPPED: IntegrationDeliveryRow = {
  id: "d4",
  connectionId: "c1",
  outboxEventId: "oe4",
  eventKey: "revenue.RENEWAL",
  providerEvent: null,
  status: "skipped",
  attempt: 1,
  httpStatus: null,
  responseBody: null,
  errorMessage: null,
  skipReason: "no_user_data",
  createdAt: "2026-05-28T07:00:00Z",
};

describe("StepDeliveries — M6.15", () => {
  it("renders both succeeded and dead_letter delivery rows", async () => {
    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/deliveries",
        () =>
          HttpResponse.json({
            data: {
              deliveries: [DELIVERY_SUCCEEDED, DELIVERY_DEAD_LETTER],
              nextCursor: null,
            },
          }),
      ),
    );

    renderWithRouter(<StepDeliveries projectId="p1" connectionId="c1" />);

    await waitFor(() => {
      expect(screen.getByText("revenue.RENEWAL")).toBeInTheDocument();
    });

    expect(screen.getByText("revenue.RENEWAL")).toBeInTheDocument();
    expect(screen.getByText("revenue.INITIAL_BUY")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("dead_letter")).toBeInTheDocument();
  });

  it("shows a Redeliver button on dead_letter and failed rows only, and calls the redeliver endpoint", async () => {
    const user = userEvent.setup();
    const redeliverSpy = vi.fn();

    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/deliveries",
        () =>
          HttpResponse.json({
            data: {
              deliveries: [DELIVERY_SUCCEEDED, DELIVERY_DEAD_LETTER, DELIVERY_FAILED],
              nextCursor: null,
            },
          }),
      ),
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/deliveries/d2/redeliver",
        () => {
          redeliverSpy();
          return HttpResponse.json({ data: { enqueued: true } }, { status: 202 });
        },
      ),
    );

    renderWithRouter(<StepDeliveries projectId="p1" connectionId="c1" />);

    await waitFor(() => {
      expect(screen.getByText("revenue.RENEWAL")).toBeInTheDocument();
    });

    const redeliverButtons = screen.getAllByRole("button", { name: /redeliver/i });
    // One per dead_letter/failed row — none for the succeeded row.
    expect(redeliverButtons).toHaveLength(2);

    await user.click(redeliverButtons[0]);

    await waitFor(() => expect(redeliverSpy).toHaveBeenCalled());
  });

  it("status filter select re-queries deliveries scoped to the selected status", async () => {
    const user = userEvent.setup();
    const requestedStatuses: Array<string | null> = [];

    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/deliveries",
        ({ request }) => {
          const url = new URL(request.url);
          requestedStatuses.push(url.searchParams.get("status"));
          const status = url.searchParams.get("status");
          const rows =
            status === "dead_letter" ? [DELIVERY_DEAD_LETTER] : [DELIVERY_SUCCEEDED, DELIVERY_DEAD_LETTER];
          return HttpResponse.json({ data: { deliveries: rows, nextCursor: null } });
        },
      ),
    );

    renderWithRouter(<StepDeliveries projectId="p1" connectionId="c1" />);

    await waitFor(() => {
      expect(screen.getByText("revenue.RENEWAL")).toBeInTheDocument();
    });

    const filter = screen.getByLabelText(/status/i);
    await user.selectOptions(filter, "dead_letter");

    await waitFor(() => {
      expect(screen.queryByText("revenue.RENEWAL")).toBeNull();
    });
    expect(screen.getByText("revenue.INITIAL_BUY")).toBeInTheDocument();
    expect(requestedStatuses).toContain("dead_letter");
  });

  it("renders the skip reason on a skipped row and nothing extra on a succeeded one", async () => {
    server.use(
      http.get(
        "http://localhost:3000/dashboard/projects/p1/integrations/c1/deliveries",
        () =>
          HttpResponse.json({
            data: {
              deliveries: [DELIVERY_SKIPPED, DELIVERY_SUCCEEDED],
              nextCursor: null,
            },
          }),
      ),
    );

    renderWithRouter(<StepDeliveries projectId="p1" connectionId="c1" />);

    await waitFor(() => {
      expect(screen.getByText("skipped")).toBeInTheDocument();
    });

    // The reason renders beside the skipped row's status badge …
    const skippedCell = screen.getByText("skipped").closest("td")!;
    expect(skippedCell.textContent).toContain("no_user_data");

    // … and the succeeded row shows a status and nothing else.
    const succeededCell = screen.getByText("succeeded").closest("td")!;
    expect(succeededCell.textContent?.trim()).toBe("succeeded");
  });
});
