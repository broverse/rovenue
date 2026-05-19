import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../render";
import { FeatureFlagsPage } from "../../src/routes/_authed/projects/$projectId/feature-flags";

describe("<FeatureFlagsPage />", () => {
  test("renders the flag key returned by the API", async () => {
    renderWithRouter(
      <FeatureFlagsPage projectId="proj_1" />,
      "/projects/proj_1/feature-flags",
    );
    await waitFor(() =>
      expect(
        screen.getByText(/show_credits_in_paywall/i),
      ).toBeInTheDocument(),
    );
  });
});
