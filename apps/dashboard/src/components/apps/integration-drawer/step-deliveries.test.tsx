import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
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
  createdAt: "2026-05-28T09:00:00Z",
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
});
