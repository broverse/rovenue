import { useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import type { IntegrationProviderId } from "@rovenue/shared";
import { cn } from "../../../lib/cn";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";
import { StepCredentials } from "./step-credentials";
import { StepCredentialsWebhook } from "./step-credentials-webhook";
import { StepEvents } from "./step-events";
import { StepMapping } from "./step-mapping";
import { StepTest } from "./step-test";
import { StepActivate } from "./step-activate";
import { StepDeliveries } from "./step-deliveries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawerStep =
  | "credentials"
  | "events"
  | "mapping"
  | "test"
  | "activate";

export interface DrawerState {
  step: DrawerStep;
  /** Credentials field values keyed by provider field id */
  credentials: Record<string, string>;
  /** Whether credentials have been validated against the provider API */
  validated: boolean;
  enabledEvents: string[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode: string;
}

function defaultState(existingConnection?: IntegrationConnectionRow | null): DrawerState {
  if (existingConnection) {
    return {
      step: "events",
      credentials: {},
      validated: true,
      enabledEvents: existingConnection.enabledEvents,
      eventMapping: existingConnection.eventMapping,
      actionSource: existingConnection.actionSource,
      testEventCode: existingConnection.testEventCode ?? "",
    };
  }
  return {
    step: "credentials",
    credentials: {},
    validated: false,
    enabledEvents: [],
    eventMapping: {},
    actionSource: "app",
    testEventCode: "",
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IntegrationDrawerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  providerId: IntegrationProviderId;
  existingConnection?: IntegrationConnectionRow | null;
}

// ---------------------------------------------------------------------------
// Step order
//
// CUSTOM_WEBHOOK skips "mapping" (there's no default event-name mapping to
// override — the provider forwards the derived event key verbatim, see
// custom-webhook.ts's `defaultEventMapping: {}`) and "test" (the existing
// test-event endpoint still works from the card if wired later, but a raw
// webhook has no third-party "Events Manager" concept to round-trip
// against). Every other provider keeps the full 5-step wizard, driven by
// this Record's fallback.
// ---------------------------------------------------------------------------

const DEFAULT_STEPS: DrawerStep[] = [
  "credentials",
  "events",
  "mapping",
  "test",
  "activate",
];

const WEBHOOK_STEPS: DrawerStep[] = ["credentials", "events", "activate"];

// AMPLITUDE has no vendor "Events Manager" / test_event_code concept (that's
// specific to Meta CAPI / TikTok Events' ad-platform test-event tooling —
// see StepTest), so its wizard skips "test" but keeps "mapping" (AMPLITUDE
// does have a per-event default vendor name that a user may want to
// override, unlike CUSTOM_WEBHOOK's WEBHOOK_STEPS).
const AMPLITUDE_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// MIXPANEL has the same shape as AMPLITUDE: no vendor "test event" tooling
// (that's Meta/TikTok-ad-platform specific), but does have a per-event
// default vendor name a user may want to override.
const MIXPANEL_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// APPSFLYER has the same shape as AMPLITUDE/MIXPANEL: no vendor "Events
// Manager" test-event tooling, but does have a per-event default `af_`
// vendor name a user may want to override.
const APPSFLYER_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// ADJUST has the same shape as AMPLITUDE/MIXPANEL/APPSFLYER: no vendor
// "Events Manager" test-event tooling. It keeps "mapping" too — unlike
// those three, ADJUST's mapping step is not optional customization but the
// ONLY way to configure anything (defaultEventMapping is `{}`; every event
// token must be entered there or the event is skipped as `no_mapping`).
const ADJUST_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// SLACK has the same shape as AMPLITUDE/MIXPANEL/APPSFLYER: no vendor
// "Events Manager" test-event tooling. It keeps "mapping" purely as
// optional customization — every catalog key already defaults to a mapped
// (identity) providerEvent, so nothing there is required the way it is for
// ADJUST.
const SLACK_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// FIREBASE_GA4 has the same shape as AMPLITUDE/MIXPANEL/APPSFLYER/SLACK: no
// vendor "Events Manager" test-event tooling (GA4's Measurement Protocol has
// no equivalent to Meta/TikTok's ad-platform test-event concept — its own
// "debug" endpoint is used internally by validateCredentials, not surfaced
// as a wizard step), but keeps "mapping" as optional customization since
// every catalog key already defaults to a mapped GA4 event name.
const FIREBASE_GA4_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

// BRAZE has the same shape as AMPLITUDE/MIXPANEL/APPSFLYER/SLACK/
// FIREBASE_GA4: no vendor "Events Manager" test-event tooling (Braze's own
// users/track probe is used internally by validateCredentials, not
// surfaced as a wizard step), but keeps "mapping" as optional customization
// — every catalog key already defaults to a mapped Braze purchase/custom
// event name (revenue.REFUND excepted, see event-mapping.ts).
const BRAZE_STEPS: DrawerStep[] = ["credentials", "events", "mapping", "activate"];

const STEPS_BY_PROVIDER: Partial<Record<IntegrationProviderId, DrawerStep[]>> = {
  CUSTOM_WEBHOOK: WEBHOOK_STEPS,
  AMPLITUDE: AMPLITUDE_STEPS,
  MIXPANEL: MIXPANEL_STEPS,
  APPSFLYER: APPSFLYER_STEPS,
  ADJUST: ADJUST_STEPS,
  SLACK: SLACK_STEPS,
  FIREBASE_GA4: FIREBASE_GA4_STEPS,
  BRAZE: BRAZE_STEPS,
};

const STEP_LABELS: Record<DrawerStep, string> = {
  credentials: "Credentials",
  events: "Events",
  mapping: "Mapping",
  test: "Test",
  activate: "Activate",
};

const PROVIDER_LABELS: Record<IntegrationProviderId, string> = {
  META_CAPI: "Meta Conversions API",
  TIKTOK_EVENTS: "TikTok Events API",
  CUSTOM_WEBHOOK: "Custom Webhook",
  AMPLITUDE: "Amplitude",
  MIXPANEL: "Mixpanel",
  APPSFLYER: "AppsFlyer",
  ADJUST: "Adjust",
  SLACK: "Slack",
  FIREBASE_GA4: "Firebase / GA4",
  BRAZE: "Braze",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IntegrationDrawer({
  open,
  onClose,
  projectId,
  providerId,
  existingConnection,
}: IntegrationDrawerProps) {
  const [state, setState] = useState<DrawerState>(() =>
    defaultState(existingConnection),
  );
  const [view, setView] = useState<"wizard" | "deliveries">("wizard");
  // CUSTOM_WEBHOOK's credentials step creates the connection immediately
  // (the server generates the signing secret at creation time — see
  // step-credentials-webhook.tsx), so the "events"/"activate" steps that
  // follow need to PATCH that connection rather than POST a new one. This
  // tracks the connection created mid-flow; every other provider never
  // sets it and keeps using `existingConnection` as-is.
  const [liveConnection, setLiveConnection] = useState<IntegrationConnectionRow | null>(
    existingConnection ?? null,
  );

  const effectiveConnection = liveConnection ?? existingConnection ?? null;
  const STEPS = STEPS_BY_PROVIDER[providerId] ?? DEFAULT_STEPS;
  const isWebhook = providerId === "CUSTOM_WEBHOOK";
  // Narrowed directly off `providerId` (not off the `isWebhook` boolean) so
  // TS actually excludes "CUSTOM_WEBHOOK" from the type — every non-webhook
  // provider (META_CAPI/TIKTOK_EVENTS/AMPLITUDE, and Tasks 6-10's) shares
  // this single-connection wizard branch below, each picking its own
  // subset of steps via STEPS_BY_PROVIDER.
  const adProviderId: Exclude<IntegrationProviderId, "CUSTOM_WEBHOOK"> | null =
    providerId === "CUSTOM_WEBHOOK" ? null : providerId;

  const currentStepIndex = STEPS.indexOf(state.step);

  const handleNext = () => {
    const next = STEPS[currentStepIndex + 1];
    if (next) setState((s) => ({ ...s, step: next }));
  };

  const handleBack = () => {
    const prev = STEPS[currentStepIndex - 1];
    if (prev) setState((s) => ({ ...s, step: prev }));
  };

  const sharedStepProps = {
    state,
    onChange: (next: DrawerState) => setState(next),
    onNext: handleNext,
    onBack: handleBack,
    onClose,
    existingConnection: effectiveConnection,
    projectId,
  };

  const providerLabel = PROVIDER_LABELS[providerId];

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity duration-200" />
        <Dialog.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-[100vw] flex-col border-l border-rv-divider bg-rv-c1 shadow-[-20px_0_60px_rgba(0,0,0,0.4)]",
            "transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full",
            "focus:outline-none",
          )}
        >
          {/* Header */}
          <header className="flex items-start justify-between gap-3 border-b border-rv-divider px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-[16px] font-semibold">
                {providerLabel}
              </Dialog.Title>
              <p className="mt-0.5 text-[12px] text-rv-mute-500">
                {STEP_LABELS[state.step]} — Step {currentStepIndex + 1} of{" "}
                {STEPS.length}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </header>

          {/* Wizard / Deliveries tab row — only when there is an existing connection */}
          {effectiveConnection && (
            <div className="flex gap-0.5 border-b border-rv-divider px-5 py-2">
              {(["wizard", "deliveries"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setView(tab)}
                  className={cn(
                    "rounded px-3 py-1 text-[12px] font-medium transition",
                    view === tab
                      ? "bg-rv-accent-500/14 text-rv-accent-400"
                      : "text-rv-mute-500 hover:text-foreground",
                  )}
                >
                  {tab === "wizard" ? "Wizard" : "Deliveries"}
                </button>
              ))}
            </div>
          )}

          {/* Step indicator — only in wizard view */}
          {view === "wizard" && (
            <div className="flex gap-1 border-b border-rv-divider px-5 py-2">
              {STEPS.map((s, i) => (
                <div
                  key={s}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    i <= currentStepIndex
                      ? "bg-rv-accent-500"
                      : "bg-rv-c3",
                  )}
                />
              ))}
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
            {view === "deliveries" && effectiveConnection ? (
              <StepDeliveries
                projectId={projectId}
                connectionId={effectiveConnection.id}
              />
            ) : isWebhook ? (
              <>
                {state.step === "credentials" && (
                  <StepCredentialsWebhook
                    state={state}
                    onChange={sharedStepProps.onChange}
                    onNext={handleNext}
                    existingConnection={effectiveConnection}
                    projectId={projectId}
                    onConnectionCreated={setLiveConnection}
                  />
                )}
                {state.step === "events" && (
                  <StepEvents {...sharedStepProps} providerId="CUSTOM_WEBHOOK" />
                )}
                {state.step === "activate" && (
                  <StepActivate {...sharedStepProps} providerId="CUSTOM_WEBHOOK" />
                )}
              </>
            ) : (
              adProviderId && (
                <>
                  {state.step === "credentials" && (
                    <StepCredentials {...sharedStepProps} providerId={adProviderId} />
                  )}
                  {state.step === "events" && (
                    <StepEvents {...sharedStepProps} providerId={adProviderId} />
                  )}
                  {state.step === "mapping" && (
                    <StepMapping {...sharedStepProps} providerId={adProviderId} />
                  )}
                  {state.step === "test" && (
                    <StepTest {...sharedStepProps} providerId={adProviderId} />
                  )}
                  {state.step === "activate" && (
                    <StepActivate {...sharedStepProps} providerId={adProviderId} />
                  )}
                </>
              )
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
