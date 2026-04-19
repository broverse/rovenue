import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../render";
import { ProjectsList } from "../../src/routes/_authed/projects.index";

describe("<ProjectsList />", () => {
  test("renders the project card + role chip + new project CTA", async () => {
    renderWithRouter(<ProjectsList />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.getByText("OWNER")).toBeInTheDocument();
    expect(screen.getByText(/new project/i)).toBeInTheDocument();
  });
});
