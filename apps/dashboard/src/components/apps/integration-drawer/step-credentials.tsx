import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepCredentialsProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  existingConnection: { id: string } | null;
  // Widened to `string` (not `IntegrationProviderId`) on purpose: this map
  // and component must compile standalone ahead of Tasks 5-10, which add
  // AMPLITUDE/MIXPANEL/APPSFLYER/ADJUST/SLACK/FIREBASE_GA4 to that shared
  // union. Callers today only ever pass "META_CAPI" | "TIKTOK_EVENTS"
  // (integration-drawer.tsx's `adProviderId`), which is a subtype of
  // `string` and stays perfectly valid here.
  providerId: string;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Provider field config
// ---------------------------------------------------------------------------

/**
 * Declarative description of one credential input. Field `id`s are the
 * backend contract: the drawer submits `state.credentials` keyed by these
 * ids, and each provider's `credentialsSchema` (apps/api/src/services/
 * integrations/providers/*.ts) validates exactly these keys.
 *
 * - `secret`: rendered with the same masked (password) input treatment as
 *   the legacy access-token field, plus a "last 4 chars" preview once the
 *   connection has been validated.
 * - `placeholder`: shown in the input when present; otherwise the field's
 *   label is used as the placeholder (matches prior behavior for the two
 *   existing fields).
 *
 * A field with `optional: true` is not required to submit — every other
 * field is. This mirrors the provider tasks' credential schemas: a field is
 * flagged `optional` exactly when the backend `credentialsSchema` allows it
 * to be absent (e.g. APPSFLYER's `app_id_ios`/`app_id_android`, guarded
 * instead by a schema-level `.refine` requiring at least one of the two).
 * The "(optional)" text some labels carry is purely a display convention —
 * required-ness is driven by this flag, not by sniffing the label string.
 */
export interface CredentialFieldDef {
  id: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  optional?: boolean;
}

// NOTE: these labels are string literals, not routed through an i18n layer.
// That mirrors existing practice in this file (and the rest of the drawer's
// step components) — the dashboard has no i18n system wired into these
// step components today, so this is not a regression, just continuity.
export const PROVIDER_CREDENTIAL_FIELDS: Record<string, CredentialFieldDef[]> = {
  // Meta renamed "Pixel ID" → "Dataset ID" in the 2023 Events Manager
  // refresh. Both terms point to the same underlying CAPI endpoint; we
  // store the value under the legacy `pixel_id` key for backwards-
  // compat with existing connections.
  META_CAPI: [
    { id: "pixel_id", label: "Dataset ID (Pixel ID)" },
    { id: "access_token", label: "Access token", secret: true },
  ],
  TIKTOK_EVENTS: [
    { id: "pixel_code", label: "Pixel ID" },
    { id: "access_token", label: "Access token", secret: true },
  ],
  // Providers below are inert until their registry entry lands in Tasks
  // 5-10 (they don't yet appear in `IntegrationProviderId`), but their
  // field ids are the fixed backend contract those tasks build against —
  // defined here verbatim per the Task 4 brief.
  AMPLITUDE: [
    { id: "api_key", label: "API key", secret: true },
    // Optional: the backend credentialsSchema types it `.optional()` and
    // both providers default to the US ingestion host when it is absent, so
    // leaving it blank must not block Validate.
    { id: "region", label: "Region (us or eu)", placeholder: "us", optional: true },
  ],
  MIXPANEL: [
    { id: "service_account_username", label: "Service account username" },
    { id: "service_account_secret", label: "Service account secret", secret: true },
    { id: "project_id", label: "Project ID" },
    // Optional: the backend credentialsSchema types it `.optional()` and
    // both providers default to the US ingestion host when it is absent, so
    // leaving it blank must not block Validate.
    { id: "region", label: "Region (us or eu)", placeholder: "us", optional: true },
  ],
  APPSFLYER: [
    { id: "dev_key", label: "Dev key", secret: true },
    { id: "app_id_ios", label: "iOS app ID (optional)", optional: true },
    { id: "app_id_android", label: "Android app ID (optional)", optional: true },
  ],
  ADJUST: [{ id: "app_token", label: "App token", secret: true }],
  SLACK: [
    {
      id: "webhook_url",
      label: "Incoming webhook URL",
      secret: true,
      placeholder: "https://hooks.slack.com/services/...",
    },
  ],
  FIREBASE_GA4: [
    { id: "api_secret", label: "Measurement Protocol API secret", secret: true },
    { id: "firebase_app_id", label: "Firebase app ID", placeholder: "1:1234567890:android:abc123" },
  ],
};

// ---------------------------------------------------------------------------
// Validate-time side-effect disclosure
// ---------------------------------------------------------------------------

/**
 * Some providers' `validateCredentials` has no zero-footprint way to check
 * a key (no dedicated credential-check endpoint) and instead POSTs a real,
 * clearly-tagged probe to the destination — a live-write side effect that
 * would otherwise only be documented on the public docs site, invisible to
 * someone validating credentials in-product. When a provider id has an
 * entry here, the note is rendered next to the Validate button so the user
 * sees the disclosure at the moment it applies, not just in the docs.
 *
 * A provider with a genuine zero-footprint validation path (a real
 * credential-check endpoint, or a request shape verified not to write
 * anything) needs NO entry — omission is a statement that Validate here is
 * side-effect-free, not an oversight.
 *
 * AMPLITUDE: kept after evaluating the brief's zero-footprint alternative
 * (`{ api_key, events: [] }`) against the vendor's documented contract —
 * the docs don't specify whether an empty `events` array is accepted or
 * rejected before the api_key check runs, so switching would rely on
 * unverified behavior (see providers/amplitude.ts's validateCredentials
 * comment). The probe now uses a STABLE insert_id
 * (AMPLITUDE_VALIDATION_INSERT_ID), so repeat validations dedupe within
 * Amplitude's 7-day window instead of writing a fresh event each time —
 * this note communicates that dedup, not an unbounded write.
 *
 * MIXPANEL: same shape as AMPLITUDE. The brief's zero-footprint
 * alternative (an empty `[]` events array to /import) was evaluated
 * against Mixpanel's documented contract and rejected — the docs specify
 * "Minimum array length: 1" for the request body, so an empty array is
 * off-contract and its response would not reliably distinguish good vs.
 * bad credentials (see providers/mixpanel.ts's validateCredentials
 * comment). The probe instead uses a stable distinct_id/$insert_id pair
 * (MIXPANEL_VALIDATION_INSERT_ID) so repeat validations collapse to one
 * Mixpanel event via the vendor's own dedup rule.
 *
 * APPSFLYER: deliberately has NO entry here (unlike AMPLITUDE/MIXPANEL).
 * Its `validateCredentials` sends nothing — no event, no request at all —
 * it only checks the submitted credentials' shape against
 * `credentialsSchema` (dev_key present, at least one app id present). There
 * is no live-write side effect to disclose. See
 * providers/appsflyer.ts's validateCredentials comment and
 * apps/docs/content/docs/integrations/appsflyer.mdx for the documented
 * "first delivery is the live proof" caveat this implies.
 *
 * SLACK: unlike AMPLITUDE/MIXPANEL's deduplicated analytics-event probe,
 * this posts a REAL, human-visible "Rovenue connected ✅" message straight
 * into the configured Slack channel — RC-parity behavior for a Slack
 * connect flow, where seeing a message land IS the confirmation. It is NOT
 * deduplicated: Slack incoming webhooks have no dedup-key concept at all
 * (see providers/slack.ts), so clicking Validate again posts another
 * message. Documented again in apps/docs/content/docs/integrations/
 * slack.mdx.
 */
export const PROVIDER_VALIDATE_NOTES: Record<string, string> = {
  AMPLITUDE:
    "Validate sends a real, clearly-tagged test event to this Amplitude project (deduplicated across repeat clicks).",
  MIXPANEL:
    "Validate sends a real, clearly-tagged test event to this Mixpanel project (deduplicated across repeat clicks).",
  SLACK:
    "Validate posts a real \"Rovenue connected ✅\" message to this Slack channel — not deduplicated, so repeat clicks post again.",
  // GA4's /debug/mp/collect endpoint validates the PAYLOAD and answers 200
  // with an empty validationMessages array for wrong-but-well-formed
  // credentials too — it never checks that the api_secret and firebase app id
  // actually belong together. Saying so here keeps a green Validate from
  // reading as proof the connection works.
  FIREBASE_GA4:
    "Validate checks the payload format only — it cannot verify the api_secret or app ID are correct. The first real delivery is the live proof.",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepCredentials({
  state,
  onChange,
  onNext,
  projectId,
  providerId,
}: StepCredentialsProps) {
  const [error, setError] = useState<string | null>(null);
  const fields = PROVIDER_CREDENTIAL_FIELDS[providerId] ?? [];
  const validateNote = PROVIDER_VALIDATE_NOTES[providerId];

  const validate = useMutation({
    mutationFn: (credentials: Record<string, string>) =>
      api<{ ok: boolean; reason?: string }>(
        `/dashboard/projects/${projectId}/integrations/validate`,
        { method: "POST", body: JSON.stringify({ providerId, credentials }) },
      ),
  });

  const valueOf = (id: string) => state.credentials[id] ?? "";
  const isOptional = (field: CredentialFieldDef) => field.optional === true;
  const canValidate = fields
    .filter((f) => !isOptional(f))
    .every((f) => valueOf(f.id).trim() !== "");

  const handleValidate = async () => {
    setError(null);
    try {
      // An optional field left blank (e.g. APPSFLYER's app_id_android when
      // only app_id_ios is set) must be OMITTED from the submitted
      // credentials, not sent as an empty string — the backend
      // credentialsSchema types an omitted optional field as `.optional()`
      // but an empty string still runs through `z.string().min(1)` and
      // fails it. A required field is never blank here (canValidate gates
      // the button on that), so no equivalent risk on that side.
      const credentials = Object.fromEntries(
        fields
          .filter((f) => !(isOptional(f) && valueOf(f.id).trim() === ""))
          .map((f) => [f.id, valueOf(f.id)]),
      );
      const result = await validate.mutateAsync(credentials);
      if (result.ok) {
        onChange({ ...state, validated: true });
      } else {
        setError(result.reason ?? "Validation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    }
  };

  // Mirrors the omission in handleValidate above: an optional field cleared
  // back to empty must drop OUT of `state.credentials` entirely rather than
  // linger as an empty string, since `state.credentials` is also what
  // step-activate.tsx submits verbatim when creating the connection (it has
  // no field-level knowledge of which keys are optional).
  const handleFieldChange = (field: CredentialFieldDef, value: string) => {
    const nextCredentials = { ...state.credentials };
    if (isOptional(field) && value.trim() === "") {
      delete nextCredentials[field.id];
    } else {
      nextCredentials[field.id] = value;
    }
    onChange({ ...state, validated: false, credentials: nextCredentials });
  };

  return (
    <div className="flex flex-col gap-5">
      {fields.map((field) => {
        const value = valueOf(field.id);
        const preview =
          field.secret && state.validated && value.length >= 4
            ? `${field.label} ending …${value.slice(-4)}`
            : null;
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            <label
              htmlFor={`cred-${field.id}`}
              className="text-[12px] font-medium text-rv-mute-700"
            >
              {field.label}
            </label>
            <input
              id={`cred-${field.id}`}
              type={field.secret ? "password" : "text"}
              value={value}
              onChange={(e) => handleFieldChange(field, e.target.value)}
              placeholder={field.placeholder ?? field.label}
              className={cn(
                "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
                "focus:border-rv-accent-500 focus:outline-none",
              )}
            />
            {preview && (
              <p className="text-[11px] text-rv-mute-500">{preview}</p>
            )}
          </div>
        );
      })}

      {error && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {error}
        </p>
      )}

      {validateNote && (
        <p className="text-[11px] text-rv-mute-500">{validateNote}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleValidate()}
          disabled={validate.isPending || !canValidate}
          className={cn(
            "rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {validate.isPending ? "Validating…" : "Validate"}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!state.validated}
          className={cn(
            "rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          Next
        </button>
      </div>
    </div>
  );
}
