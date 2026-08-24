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
 * A field whose label contains "(optional)" is not required to submit —
 * every other field is. This mirrors the six provider tasks' credential
 * schemas (Task 4 brief): required fields carry no such marker.
 */
export interface CredentialFieldDef {
  id: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
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
    { id: "region", label: "Region (us or eu)", placeholder: "us" },
  ],
  MIXPANEL: [
    { id: "service_account_username", label: "Service account username" },
    { id: "service_account_secret", label: "Service account secret", secret: true },
    { id: "project_id", label: "Project ID" },
    { id: "region", label: "Region (us or eu)", placeholder: "us" },
  ],
  APPSFLYER: [
    { id: "dev_key", label: "Dev key", secret: true },
    { id: "app_id_ios", label: "iOS app ID (optional)" },
    { id: "app_id_android", label: "Android app ID (optional)" },
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

  const validate = useMutation({
    mutationFn: (credentials: Record<string, string>) =>
      api<{ ok: boolean; reason?: string }>(
        `/dashboard/projects/${projectId}/integrations/validate`,
        { method: "POST", body: JSON.stringify({ providerId, credentials }) },
      ),
  });

  const valueOf = (id: string) => state.credentials[id] ?? "";
  const isOptional = (field: CredentialFieldDef) => field.label.includes("(optional)");
  const canValidate = fields
    .filter((f) => !isOptional(f))
    .every((f) => valueOf(f.id).trim() !== "");

  const handleValidate = async () => {
    setError(null);
    try {
      const credentials = Object.fromEntries(
        fields.map((f) => [f.id, valueOf(f.id)]),
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
              onChange={(e) =>
                onChange({
                  ...state,
                  validated: false,
                  credentials: { ...state.credentials, [field.id]: e.target.value },
                })
              }
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
