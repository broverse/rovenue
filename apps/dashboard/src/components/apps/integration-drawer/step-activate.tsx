import {
  useCreateIntegration,
  useUpdateIntegration,
} from "../../../lib/hooks/useProjectIntegrations";
import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";
import type { IntegrationConnectionRow } from "../../../lib/hooks/useProjectIntegrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepActivateProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  onBack: () => void;
  onClose: () => void;
  existingConnection: IntegrationConnectionRow | null;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepActivate({
  state,
  onBack,
  onClose,
  existingConnection,
  providerId,
  projectId,
}: StepActivateProps) {
  const create = useCreateIntegration(projectId);
  const update = useUpdateIntegration(projectId);

  const isPending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const providerLabel =
    providerId === "META_CAPI" ? "Meta Conversions API" : "TikTok Events API";

  const handleActivate = async () => {
    try {
      if (existingConnection) {
        // Update existing connection
        await update.mutateAsync({
          connectionId: existingConnection.id,
          body: {
            isEnabled: true,
            enabledEvents: state.enabledEvents,
            eventMapping: state.eventMapping,
            actionSource: state.actionSource,
            testEventCode: state.testEventCode || null,
          },
        });
      } else {
        // Create new connection
        const created = await create.mutateAsync({
          providerId,
          displayName: providerLabel,
          credentials: state.credentials,
          enabledEvents: state.enabledEvents,
          eventMapping: state.eventMapping,
          actionSource: state.actionSource,
          testEventCode: state.testEventCode || null,
          isEnabled: true,
        });
        // Ensure isEnabled on the newly created connection
        await update.mutateAsync({
          connectionId: created.id,
          body: { isEnabled: true },
        });
      }
      onClose();
    } catch {
      // error is surfaced via mutation state
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] text-rv-mute-500">
        Review your configuration and activate the integration.
      </p>

      {/* Summary */}
      <div className="rounded-md border border-rv-divider bg-rv-c2 p-4">
        <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          Configuration summary
        </div>
        <dl className="m-0 flex flex-col gap-1">
          <SummaryRow k="Provider" v={providerLabel} />
          <SummaryRow
            k="Action source"
            v={state.actionSource}
          />
          <SummaryRow
            k="Events"
            v={
              state.enabledEvents.length === 0
                ? "(none)"
                : state.enabledEvents.join(", ")
            }
          />
          {state.testEventCode && (
            <SummaryRow k="Test event code" v={state.testEventCode} />
          )}
        </dl>
      </div>

      {error && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {error instanceof Error ? error.message : "Activation failed"}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="rounded-md border border-rv-divider bg-rv-c2 px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-rv-c3 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleActivate()}
          disabled={isPending}
          className={cn(
            "rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isPending ? "Activating…" : "Activate"}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 py-1 text-[12px]">
      <dt className="font-rv-mono text-[11px] text-rv-mute-500">{k}</dt>
      <dd className="m-0 break-all font-rv-mono text-rv-mute-800">{v}</dd>
    </div>
  );
}
