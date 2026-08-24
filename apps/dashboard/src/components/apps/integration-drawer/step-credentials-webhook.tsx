import { useState } from "react";
import {
  useCreateIntegration,
  type IntegrationConnectionRow,
} from "../../../lib/hooks/useProjectIntegrations";
import { CopyButton } from "../../../ui/copy-button";
import { cn } from "../../../lib/cn";
import type { DrawerState } from "./integration-drawer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepCredentialsWebhookProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onNext: () => void;
  existingConnection: IntegrationConnectionRow | null;
  projectId: string;
  /** Lifts the connection created here up to the drawer so the later
   *  "events" / "activate" steps operate against it (PATCH, not POST). */
  onConnectionCreated: (connection: IntegrationConnectionRow) => void;
}

// ---------------------------------------------------------------------------
// URL check — client-side mirror of the server's `assertPublicWebhookUrl`
// scheme check (apps/api/src/lib/ssrf-guard.ts). This is a cheap UX
// pre-check only: the server re-validates (and additionally rejects
// private/loopback targets) before ever persisting or delivering to it.
// ---------------------------------------------------------------------------

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function deriveDisplayName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Webhook endpoint";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepCredentialsWebhook({
  state,
  onChange,
  onNext,
  projectId,
  onConnectionCreated,
}: StepCredentialsWebhookProps) {
  const [error, setError] = useState<string | null>(null);
  // The server-generated signing secret — held only in this component's
  // in-memory state, shown exactly once, never written to localStorage
  // or persisted anywhere else on the client.
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const create = useCreateIntegration(projectId);

  const url = state.credentials.url ?? "";
  const urlValid = url.trim() !== "" && isHttpsUrl(url);

  const handleCreate = async () => {
    setError(null);
    try {
      const result = await create.mutateAsync({
        providerId: "CUSTOM_WEBHOOK",
        displayName: deriveDisplayName(url),
        credentials: { url },
      });
      onConnectionCreated(result.connection);
      setCreatedSecret(result.secret ?? null);
      onChange({ ...state, validated: true });
    } catch (err) {
      // ApiError (409 endpoint_limit_reached / connection_exists, 400
      // invalid_credentials) extends Error, so its `.message` surfaces here
      // too — no separate branch needed.
      setError(err instanceof Error ? err.message : "Failed to create webhook endpoint");
    }
  };

  if (createdSecret) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-[12px] text-rv-mute-500">
          Your webhook endpoint was created. Copy the signing secret below.
        </p>

        <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-rv-mono text-[12px] text-foreground">
              {createdSecret}
            </code>
            <CopyButton size="xs" value={createdSecret} label="Copy" copiedLabel="Copied" />
          </div>
          <p className="mt-1 text-[11px] text-rv-warning">
            Copy this now — it won&apos;t be shown again. You can rotate the
            secret later from the endpoint's row on the Apps page.
          </p>
        </div>

        <div className="flex items-center gap-2">
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="webhook-url"
          className="text-[12px] font-medium text-rv-mute-700"
        >
          Endpoint URL
        </label>
        <input
          id="webhook-url"
          type="text"
          value={url}
          onChange={(e) =>
            onChange({
              ...state,
              validated: false,
              credentials: { ...state.credentials, url: e.target.value },
            })
          }
          placeholder="https://api.yourapp.com/webhooks/rovenue"
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
            "focus:border-rv-accent-500 focus:outline-none",
          )}
        />
        {url.trim() !== "" && !urlValid && (
          <p className="text-[11px] text-rv-danger" role="alert">
            Enter a valid https:// URL.
          </p>
        )}
      </div>

      {error && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!urlValid || create.isPending}
          className={cn(
            "rounded-md bg-rv-accent-500 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-rv-accent-600",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {create.isPending ? "Creating…" : "Create endpoint"}
        </button>
      </div>
    </div>
  );
}
