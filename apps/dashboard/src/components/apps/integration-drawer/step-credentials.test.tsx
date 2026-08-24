import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../../tests/msw/server";
import { renderWithRouter } from "../../../../tests/render";
import {
  StepCredentials,
  PROVIDER_CREDENTIAL_FIELDS,
  PROVIDER_VALIDATE_NOTES,
} from "./step-credentials";
import type { DrawerState } from "./integration-drawer";

const BASE_STATE: DrawerState = {
  step: "credentials",
  credentials: {},
  validated: false,
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

/** Stateful wrapper so the controlled inputs reflect onChange calls */
function Wrapper({ onValidated }: { onValidated: (s: DrawerState) => void }) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepCredentials
      state={state}
      onChange={(next) => {
        setState(next);
        if (next.validated) onValidated(next);
      }}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={null}
      providerId="META_CAPI"
      projectId="p1"
    />
  );
}

describe("StepCredentials", () => {
  it("validates credentials, calls onChange with validated=true, shows token preview, then Next button becomes enabled", async () => {
    const user = userEvent.setup();
    const onValidated = vi.fn();
    const postSpy = vi.fn();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/validate",
        async ({ request }) => {
          postSpy(await request.json());
          return HttpResponse.json({ data: { ok: true } });
        },
      ),
    );

    renderWithRouter(<Wrapper onValidated={onValidated} />);

    const idInput = await screen.findByLabelText(/pixel id/i);
    const tokenInput = await screen.findByLabelText(/access token/i);

    await user.type(idInput, "123456789");
    await user.type(tokenInput, "tok_abcd1234");

    const validateBtn = screen.getByRole("button", { name: /validate/i });
    await user.click(validateBtn);

    // Wait for onChange to be called with validated=true
    await waitFor(() => expect(onValidated).toHaveBeenCalled());

    const validatedState = onValidated.mock.calls[0][0] as DrawerState;
    expect(validatedState.validated).toBe(true);

    // Token preview should show last 4 chars of the token
    expect(await screen.findByText(/1234/)).toBeTruthy();

    // Next button should be enabled
    const nextBtn = screen.getByRole("button", { name: /next/i });
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);

    // Regression guard for the snake_case fix: the backend's
    // credentialsSchema (meta-capi.ts) only accepts `pixel_id` +
    // `access_token` — camelCase ids fail validation silently for real
    // Meta accounts even though this mocked test route doesn't enforce it.
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "META_CAPI",
        credentials: { pixel_id: "123456789", access_token: "tok_abcd1234" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Declarative multi-field providers (Task 4: PROVIDER_CREDENTIAL_FIELDS)
// ---------------------------------------------------------------------------

const MIXPANEL_STATE: DrawerState = {
  step: "credentials",
  credentials: {},
  validated: false,
  enabledEvents: [],
  eventMapping: {},
  actionSource: "app",
  testEventCode: "",
};

/** Escapes regex metacharacters so a field's label (e.g. "Region (us or eu)")
 *  can be used as a literal-text matcher in findByLabelText. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Stateful wrapper generalized over any provider in PROVIDER_CREDENTIAL_FIELDS. */
function MixpanelWrapper({ onValidated }: { onValidated: (s: DrawerState) => void }) {
  const [state, setState] = useState<DrawerState>(MIXPANEL_STATE);
  return (
    <StepCredentials
      state={state}
      onChange={(next) => {
        setState(next);
        if (next.validated) onValidated(next);
      }}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={null}
      providerId="MIXPANEL"
      projectId="p1"
    />
  );
}

describe("StepCredentials — declarative multi-field providers (MIXPANEL)", () => {
  it("renders one labeled input per field in PROVIDER_CREDENTIAL_FIELDS.MIXPANEL", async () => {
    renderWithRouter(<MixpanelWrapper onValidated={vi.fn()} />);

    const fields = PROVIDER_CREDENTIAL_FIELDS.MIXPANEL;
    expect(fields).toHaveLength(4);

    for (const field of fields) {
      expect(await screen.findByLabelText(new RegExp(escapeRegExp(field.label), "i"))).toBeTruthy();
    }
  });

  it("renders secret fields with the same masked (password) treatment as the existing access-token field", async () => {
    renderWithRouter(<MixpanelWrapper onValidated={vi.fn()} />);

    for (const field of PROVIDER_CREDENTIAL_FIELDS.MIXPANEL) {
      const input = (await screen.findByLabelText(
        new RegExp(escapeRegExp(field.label), "i"),
      )) as HTMLInputElement;
      expect(input.type).toBe(field.secret ? "password" : "text");
    }
  });

  it("submits credentials keyed by the provider's field ids on Validate", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn();

    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/p1/integrations/validate",
        async ({ request }) => {
          postSpy(await request.json());
          return HttpResponse.json({ data: { ok: true } });
        },
      ),
    );

    renderWithRouter(<MixpanelWrapper onValidated={vi.fn()} />);

    const values: Record<string, string> = {
      service_account_username: "svc.acct",
      service_account_secret: "sec_abcd1234",
      project_id: "proj_1",
      region: "us",
    };

    for (const field of PROVIDER_CREDENTIAL_FIELDS.MIXPANEL) {
      const input = await screen.findByLabelText(new RegExp(escapeRegExp(field.label), "i"));
      await user.type(input, values[field.id]);
    }

    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "MIXPANEL",
        credentials: values,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_VALIDATE_NOTES — validate-time side-effect disclosure
// (review-fix: a live-write side effect on Validate must be surfaced
// in-product, not just documented on the public docs site)
// ---------------------------------------------------------------------------

function ProviderWrapper({ providerId }: { providerId: string }) {
  const [state, setState] = useState<DrawerState>(BASE_STATE);
  return (
    <StepCredentials
      state={state}
      onChange={setState}
      onNext={vi.fn()}
      onBack={vi.fn()}
      existingConnection={null}
      providerId={providerId}
      projectId="p1"
    />
  );
}

describe("StepCredentials — PROVIDER_VALIDATE_NOTES", () => {
  it("renders the note near Validate when the provider has one (AMPLITUDE)", async () => {
    renderWithRouter(<ProviderWrapper providerId="AMPLITUDE" />);

    expect(await screen.findByLabelText(/api key/i)).toBeTruthy();
    expect(screen.getByText(PROVIDER_VALIDATE_NOTES.AMPLITUDE)).toBeTruthy();
  });

  it("renders no note for a provider without one (META_CAPI)", async () => {
    renderWithRouter(<ProviderWrapper providerId="META_CAPI" />);

    expect(await screen.findByLabelText(/pixel id/i)).toBeTruthy();
    expect(PROVIDER_VALIDATE_NOTES.META_CAPI).toBeUndefined();
    // No provider-note text node should be present at all for META_CAPI.
    for (const note of Object.values(PROVIDER_VALIDATE_NOTES)) {
      expect(screen.queryByText(note)).toBeNull();
    }
  });
});
