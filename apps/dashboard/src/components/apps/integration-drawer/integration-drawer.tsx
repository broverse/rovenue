import { useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";
import { StepCredentials } from "./step-credentials";
import { StepEvents } from "./step-events";
import { StepMapping } from "./step-mapping";
import { StepTest } from "./step-test";
import { StepActivate } from "./step-activate";

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
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  existingConnection?: IntegrationConnectionRow | null;
}

// ---------------------------------------------------------------------------
// Step order
// ---------------------------------------------------------------------------

const STEPS: DrawerStep[] = [
  "credentials",
  "events",
  "mapping",
  "test",
  "activate",
];

const STEP_LABELS: Record<DrawerStep, string> = {
  credentials: "Credentials",
  events: "Events",
  mapping: "Mapping",
  test: "Test",
  activate: "Activate",
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
    existingConnection: existingConnection ?? null,
    providerId,
    projectId,
  };

  const providerLabel =
    providerId === "META_CAPI" ? "Meta Conversions API" : "TikTok Events API";

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

          {/* Step indicator */}
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

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
            {state.step === "credentials" && (
              <StepCredentials {...(sharedStepProps as Record<string, unknown>)} />
            )}
            {state.step === "events" && (
              <StepEvents {...(sharedStepProps as Record<string, unknown>)} />
            )}
            {state.step === "mapping" && (
              <StepMapping {...(sharedStepProps as Record<string, unknown>)} />
            )}
            {state.step === "test" && (
              <StepTest {...(sharedStepProps as Record<string, unknown>)} />
            )}
            {state.step === "activate" && (
              <StepActivate {...(sharedStepProps as Record<string, unknown>)} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
