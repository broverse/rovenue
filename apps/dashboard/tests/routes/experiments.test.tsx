import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../render";
import { ExperimentsPage } from "../../src/routes/_authed/projects/$projectId/experiments";

describe("<ExperimentsPage />", () => {
  test("renders the running experiment from the API", async () => {
    renderWithRouter(
      <ExperimentsPage projectId="proj_1" />,
      "/projects/proj_1/experiments",
    );
    await waitFor(() =>
      expect(
        screen.getByText(/paywall_v2_pricing/i),
      ).toBeInTheDocument(),
    );
  });
});
