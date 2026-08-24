import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import { StepCredentialsWebhook } from "./step-credentials-webhook";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";

const BASE_STATE: DrawerState = {
  step: "credentials",
  credentials: {},
  validated: false,
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

const CREATED_CONNECTION: IntegrationConnectionRow = {
  id: "wh1",
  providerId: "CUSTOM_WEBHOOK",
  displayName: "api.example.com",
  credentialsHint: "api.example.com · …abcd",
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: false,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: "2026-08-24T00:00:00Z",
  updatedAt: "2026-08-24T00:00:00Z",
};

function Wrapper({
  onConnectionCreated,
  onNext,
}: {
  onConnectionCreated: (c: IntegrationConnectionRow) => void;
  onNext: () => void;
}) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepCredentialsWebhook
      state={state}
      onChange={setState}
      onNext={onNext}
      existingConnection={null}
      projectId="p1"
      onConnectionCreated={onConnectionCreated}
    />
  );
}

describe("StepCredentialsWebhook", () => {
  it("shows a URL field, not the ad-provider pixel fields", async () => {
    renderWithRouter(<Wrapper onConnectionCreated={vi.fn()} onNext={vi.fn()} />);

    expect(await screen.findByLabelText(/endpoint url/i)).toBeTruthy();
    expect(screen.queryByLabelText(/pixel/i)).toBeNull();
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });

  it("rejects a non-https URL client-side before any request is sent", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn();
    server.use(
      http.post("http://localhost:3000/dashboard/projects/p1/integrations", async ({ request }) => {
        postSpy(await request.json());
        return HttpResponse.json({ data: { connection: CREATED_CONNECTION, secret: "whsec_x" } }, { status: 201 });
      }),
    );

    renderWithRouter(<Wrapper onConnectionCreated={vi.fn()} onNext={vi.fn()} />);

    const urlInput = await screen.findByLabelText(/endpoint url/i);
    await user.type(urlInput, "http://insecure.example.com");

    expect(await screen.findByText(/valid https/i)).toBeTruthy();
    const createBtn = screen.getByRole("button", { name: /create endpoint/i });
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("creates the endpoint and shows the returned secret exactly once, in a copy-to-clipboard block", async () => {
    const user = userEvent.setup();
    const onConnectionCreated = vi.fn();

    server.use(
      http.post("http://localhost:3000/dashboard/projects/p1/integrations", async ({ request }) => {
        const body = (await request.json()) as { providerId: string; credentials: Record<string, string> };
        expect(body.providerId).toBe("CUSTOM_WEBHOOK");
        expect(body.credentials).toEqual({ url: "https://api.example.com/hooks" });
        return HttpResponse.json(
          { data: { connection: CREATED_CONNECTION, secret: "whsec_supersecret1234" } },
          { status: 201 },
        );
      }),
    );

    renderWithRouter(<Wrapper onConnectionCreated={onConnectionCreated} onNext={vi.fn()} />);

    const urlInput = await screen.findByLabelText(/endpoint url/i);
    await user.type(urlInput, "https://api.example.com/hooks");

    const createBtn = screen.getByRole("button", { name: /create endpoint/i });
    await waitFor(() => expect((createBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(createBtn);

    // Secret appears exactly once, in a copyable block with the warning.
    expect(await screen.findByText("whsec_supersecret1234")).toBeTruthy();
    expect(screen.getByText(/won't be shown again/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();

    // The URL form is gone — can't accidentally re-submit.
    expect(screen.queryByLabelText(/endpoint url/i)).toBeNull();

    await waitFor(() => expect(onConnectionCreated).toHaveBeenCalledWith(CREATED_CONNECTION));
  });

  it("clicking Next after creation advances the wizard", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();

    server.use(
      http.post("http://localhost:3000/dashboard/projects/p1/integrations", () =>
        HttpResponse.json(
          { data: { connection: CREATED_CONNECTION, secret: "whsec_abc" } },
          { status: 201 },
        ),
      ),
    );

    renderWithRouter(<Wrapper onConnectionCreated={vi.fn()} onNext={onNext} />);

    const urlInput = await screen.findByLabelText(/endpoint url/i);
    await user.type(urlInput, "https://api.example.com/hooks");
    await user.click(screen.getByRole("button", { name: /create endpoint/i }));

    const nextBtn = await screen.findByRole("button", { name: /^next$/i });
    await user.click(nextBtn);

    expect(onNext).toHaveBeenCalled();
  });

  it("surfaces a 409 endpoint_limit_reached error without creating a connection", async () => {
    const user = userEvent.setup();
    const onConnectionCreated = vi.fn();

    server.use(
      http.post("http://localhost:3000/dashboard/projects/p1/integrations", () =>
        HttpResponse.json(
          {
            error: {
              code: "endpoint_limit_reached",
              message: "A project may have at most 10 webhook endpoints",
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderWithRouter(<Wrapper onConnectionCreated={onConnectionCreated} onNext={vi.fn()} />);

    const urlInput = await screen.findByLabelText(/endpoint url/i);
    await user.type(urlInput, "https://api.example.com/hooks");
    await user.click(screen.getByRole("button", { name: /create endpoint/i }));

    expect(await screen.findByText(/at most 10 webhook endpoints/i)).toBeTruthy();
    expect(onConnectionCreated).not.toHaveBeenCalled();
  });
});
