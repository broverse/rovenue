import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../render";
import { NewProjectPage } from "../../src/routes/_authed/projects.new";

describe("<NewProjectPage />", () => {
  test("submitting valid name+slug reveals both API keys", async () => {
    const user = userEvent.setup();
    renderWithRouter(<NewProjectPage />);

    const nameInput = await screen.findByLabelText(/project name/i);
    await user.type(nameInput, "Alpha");
    await user.type(screen.getByLabelText(/slug/i), "alpha");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(screen.getByText(/save your api keys/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/rov_pub_test_xxx/)).toBeInTheDocument();
    expect(screen.getByText(/rov_sec_test_yyy/)).toBeInTheDocument();
  });
});
