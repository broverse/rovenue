import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../render";
import { SubscriberDetailPage } from "../../src/routes/_authed/projects/$projectId/subscribers/$id";

describe("<SubscriberDetailPage />", () => {
  test("renders appUserId, balance, and the premium entitlement", async () => {
    renderWithRouter(
      <SubscriberDetailPage projectId="proj_1" id="sub_1" />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("premium")).toBeInTheDocument();
  });
});
