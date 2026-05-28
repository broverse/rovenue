import { ExternalLink } from "lucide-react";
import { useTestIntegrationEvent } from "../../../lib/hooks/useProjectIntegrations";
import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepTestProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  existingConnection: { id: string } | null;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
}

// ---------------------------------------------------------------------------
// Provider Events Manager URLs
// ---------------------------------------------------------------------------

const EVENTS_MANAGER_URLS: Record<"META_CAPI" | "TIKTOK_EVENTS", string> = {
  META_CAPI: "https://business.facebook.com/events_manager",
  TIKTOK_EVENTS: "https://ads.tiktok.com/i18n/events_manager",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepTest({
  state,
  onChange,
  onNext,
  onBack,
  existingConnection,
  providerId,
  projectId,
}: StepTestProps) {
  const connectionId = existingConnection?.id ?? "";
  const testMutation = useTestIntegrationEvent(projectId, connectionId);

  const canSend = Boolean(connectionId) && Boolean(state.testEventCode);
  const eventsManagerUrl = EVENTS_MANAGER_URLS[providerId];

  const handleSend = () => {
    testMutation.mutate();
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] text-rv-mute-500">
        Send a test event to verify your integration is correctly wired.
      </p>

      {/* Test event code input */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="test-event-code"
          className="text-[12px] font-medium text-rv-mute-700"
        >
          Test event code
        </label>
        <input
          id="test-event-code"
          type="text"
          value={state.testEventCode}
          onChange={(e) =>
            onChange({ ...state, testEventCode: e.target.value })
          }
          placeholder="e.g. TEST12345"
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
            "focus:border-rv-accent-500 focus:outline-none",
          )}
        />
      </div>

      {/* Send button */}
      <button
        type="button"
        onClick={handleSend}
        disabled={!canSend || testMutation.isPending}
        className={cn(
          "self-start rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {testMutation.isPending ? "Sending…" : "Send test event"}
      </button>

      {/* Result */}
      {testMutation.data && (
        <details open className="rounded-md border border-rv-divider bg-rv-c2 p-3">
          <summary className="cursor-pointer text-[12px] font-medium text-rv-mute-700">
            HTTP {testMutation.data.httpStatus}
          </summary>
          <pre className="mt-2 overflow-x-auto font-rv-mono text-[11px] text-rv-mute-800 whitespace-pre-wrap break-all">
            {testMutation.data.responseBody}
          </pre>
        </details>
      )}

      {testMutation.isError && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {testMutation.error instanceof Error
            ? testMutation.error.message
            : "Failed to send test event"}
        </p>
      )}

      {/* External link to Events Manager */}
      <a
        href={eventsManagerUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-[12px] text-rv-accent-500 hover:underline"
      >
        Open Events Manager
        <ExternalLink size={11} />
      </a>

      {/* Navigation */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600"
        >
          Next
        </button>
      </div>
    </div>
  );
}
