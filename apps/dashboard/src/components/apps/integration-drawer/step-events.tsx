import { useState } from "react";
import type { IntegrationProviderId } from "@rovenue/shared";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";
import { cn } from "../../../lib/cn";
import {
  useRevealWebhookSecret,
  useRotateWebhookSecret,
  type IntegrationConnectionRow,
} from "../../../lib/hooks/useProjectIntegrations";
import { CopyButton } from "../../../ui/copy-button";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepEventsProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  existingConnection: IntegrationConnectionRow | null;
  providerId: IntegrationProviderId;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Event keys
// ---------------------------------------------------------------------------

// Mirrors apps/api/src/services/integrations/providers/{meta-capi,
// tiktok-events}.ts's `eventCatalog` — the subset of Rovenue event keys
// those two ad-provider mappers actually support.
export const ALL_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
] as const;

// Mirrors apps/api/src/services/integrations/providers/amplitude.ts's
// `eventCatalog` — the 13-key Wave-1 revenue + subscription-lifecycle set
// AMPLITUDE supports (a superset of the two ad-providers' list above: it
// adds REFUND/CANCELLATION plus the six non-trial subscription-lifecycle
// keys, and drops subscriber.identified, which AMPLITUDE has no mapping for).
const AMPLITUDE_EVENT_KEYS = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
] as const;

// Mirrors apps/api/src/services/integrations/providers/mixpanel.ts's
// `eventCatalog` — identical to AMPLITUDE's (Task 6 brief: "Topics/
// catalog/mapping keys identical to Amplitude").
const MIXPANEL_EVENT_KEYS = AMPLITUDE_EVENT_KEYS;

// CUSTOM_WEBHOOK has no per-event allowlist on the backend — its
// `eventCatalog` is `ROVENUE_EVENT_KEYS` in full (custom-webhook.ts) — so
// the picker offers every public event key rather than the ad-providers'
// narrower list above.
const EVENT_KEYS_BY_PROVIDER: Record<IntegrationProviderId, readonly string[]> = {
  META_CAPI: ALL_EVENT_KEYS,
  TIKTOK_EVENTS: ALL_EVENT_KEYS,
  CUSTOM_WEBHOOK: ROVENUE_EVENT_KEYS,
  AMPLITUDE: AMPLITUDE_EVENT_KEYS,
  MIXPANEL: MIXPANEL_EVENT_KEYS,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepEvents({
  state,
  onChange,
  onNext,
  onBack,
  existingConnection,
  providerId,
  projectId,
}: StepEventsProps) {
  const eventKeys = EVENT_KEYS_BY_PROVIDER[providerId];
  const isExistingWebhook = providerId === "CUSTOM_WEBHOOK" && existingConnection !== null;
  // CUSTOM_WEBHOOK's "credentials" step both creates the connection AND is
  // where the drawer's create-vs-edit branching lives (integration-
  // drawer.tsx renders StepCredentialsWebhook there unconditionally) — once
  // the connection exists (new or pre-existing), going back to it would
  // re-show the "create a new endpoint" form, not an editable URL field.
  // There's nothing useful to go back to, so the webhook flow hides Back
  // here entirely.
  const canGoBack = providerId !== "CUSTOM_WEBHOOK";

  const toggleEvent = (key: string) => {
    const isEnabled = state.enabledEvents.includes(key);
    const next = isEnabled
      ? state.enabledEvents.filter((k) => k !== key)
      : [...state.enabledEvents, key];
    onChange({ ...state, enabledEvents: next });
  };

  return (
    <div className="flex flex-col gap-5">
      {isExistingWebhook && existingConnection && (
        <WebhookSecretPanel projectId={projectId} connectionId={existingConnection.id} />
      )}

      <p className="text-[12px] text-rv-mute-500">
        Choose which events are forwarded to the integration.
      </p>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {eventKeys.map((key) => {
          const checked = state.enabledEvents.includes(key);
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition hover:bg-rv-c2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleEvent(key)}
                  aria-label={key}
                  className="size-4 cursor-pointer accent-rv-accent-500"
                />
                <span className="font-rv-mono text-[12px] text-rv-mute-800">
                  {key}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2">
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3",
            )}
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          disabled={state.enabledEvents.length === 0}
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

// ---------------------------------------------------------------------------
// Webhook signing-secret panel — CUSTOM_WEBHOOK, existing connection only.
// Reveal is audited server-side (GET .../secret) and rotate replaces the
// active key server-side (POST .../rotate-secret); neither value is ever
// written anywhere but this component's own React state.
// ---------------------------------------------------------------------------

function WebhookSecretPanel({
  projectId,
  connectionId,
}: {
  projectId: string;
  connectionId: string;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [justRotated, setJustRotated] = useState(false);
  const reveal = useRevealWebhookSecret(projectId);
  const rotate = useRotateWebhookSecret(projectId);

  const handleReveal = async () => {
    const result = await reveal.mutateAsync(connectionId);
    setJustRotated(false);
    setSecret(result.secret);
  };

  const handleRotate = async () => {
    const result = await rotate.mutateAsync(connectionId);
    setJustRotated(true);
    setSecret(result.secret);
  };

  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        Signing secret
      </div>
      {secret ? (
        <>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-rv-mono text-[12px] text-foreground">
              {secret}
            </code>
            <CopyButton size="xs" value={secret} label="Copy" copiedLabel="Copied" />
          </div>
          <p className="mt-1 text-[11px] text-rv-warning">
            {justRotated
              ? "Copy this now — it won't be shown again."
              : "Shown once per reveal — re-reveal any time, each reveal is audited."}
          </p>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleReveal()}
            disabled={reveal.isPending}
            className="rounded border border-rv-divider bg-rv-c1 px-2.5 py-1 text-[11.5px] font-medium text-foreground transition hover:bg-rv-c3 disabled:opacity-50"
          >
            {reveal.isPending ? "Revealing…" : "Reveal secret"}
          </button>
          <button
            type="button"
            onClick={() => void handleRotate()}
            disabled={rotate.isPending}
            className="rounded border border-rv-divider bg-rv-c1 px-2.5 py-1 text-[11.5px] font-medium text-foreground transition hover:bg-rv-c3 disabled:opacity-50"
          >
            {rotate.isPending ? "Rotating…" : "Rotate secret"}
          </button>
        </div>
      )}
    </div>
  );
}
