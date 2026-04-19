import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../render";
import { SubscribersPage } from "../../src/routes/_authed/projects/$projectId/subscribers/index";

describe("<SubscribersPage />", () => {
  test("renders subscribers and the search hides them when q is set", async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <SubscribersPage projectId="proj_1" />,
      "/projects/proj_1/subscribers",
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("bob")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/search/i), "nobody");
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  });
});
