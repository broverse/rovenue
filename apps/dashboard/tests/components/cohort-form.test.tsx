import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, waitFor, screen } from "@testing-library/react";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { CohortForm } from "../../src/components/cohorts/cohort-form";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../src/i18n/config";

describe("CohortForm (create)", () => {
  it("submits POST with name + rules and calls onSuccess with the new id", async () => {
    const onSuccess = vi.fn();
    renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );

    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: "EU customers" } });

    const submitBtn = await screen.findByText(/create cohort/i);
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalledWith("coh_new");
  });

  it("shows an inline name error on 409 nameInUse", async () => {
    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/:projectId/cohorts",
        () =>
          HttpResponse.json(
            { error: { code: "CONFLICT", message: "Cohort name already in use: EU" } },
            { status: 409 },
          ),
      ),
    );

    renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: "EU" } });

    const submitBtn = await screen.findByText(/create cohort/i);
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/already exists/i)).toBeTruthy();
  });

  it("disables submit while name is empty", async () => {
    renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const btn = (await screen.findByText(/create cohort/i)).closest("button");
    expect(btn?.disabled).toBe(true);
  });
});
