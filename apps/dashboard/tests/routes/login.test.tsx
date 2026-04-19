import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../render";
import { LoginPage } from "../../src/routes/login";

describe("<Login />", () => {
  test("renders GitHub and Google buttons", async () => {
    renderWithRouter(<LoginPage />);
    expect(
      await screen.findByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
  });
});
