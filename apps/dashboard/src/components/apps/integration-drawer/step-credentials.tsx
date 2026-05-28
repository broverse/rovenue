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
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  projectId: string;
}

// ---------------------------------------------------------------------------
// Provider field config
// ---------------------------------------------------------------------------

const PROVIDER_FIELDS: Record<
  "META_CAPI" | "TIKTOK_EVENTS",
  { id: string; label: string }
> = {
  META_CAPI: { id: "pixelId", label: "Pixel ID" },
  TIKTOK_EVENTS: { id: "pixelCode", label: "Pixel Code" },
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
  const field = PROVIDER_FIELDS[providerId];

  const validate = useMutation({
    mutationFn: (credentials: Record<string, string>) =>
      api<{ ok: boolean; reason?: string }>(
        `/dashboard/projects/${projectId}/integrations/validate`,
        { method: "POST", body: JSON.stringify({ providerId, credentials }) },
      ),
  });

  const idValue = state.credentials[field.id] ?? "";
  const tokenValue = state.credentials.accessToken ?? "";
  const tokenPreview = state.validated && tokenValue.length >= 4
    ? `Token ending …${tokenValue.slice(-4)}`
    : null;

  const handleValidate = async () => {
    setError(null);
    try {
      const result = await validate.mutateAsync({
        [field.id]: idValue,
        accessToken: tokenValue,
      });
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
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="cred-id"
          className="text-[12px] font-medium text-rv-mute-700"
        >
          {field.label}
        </label>
        <input
          id="cred-id"
          type="text"
          value={idValue}
          onChange={(e) =>
            onChange({
              ...state,
              validated: false,
              credentials: { ...state.credentials, [field.id]: e.target.value },
            })
          }
          placeholder={field.label}
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
            "focus:border-rv-accent-500 focus:outline-none",
          )}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="cred-token"
          className="text-[12px] font-medium text-rv-mute-700"
        >
          Access Token
        </label>
        <input
          id="cred-token"
          type="password"
          value={tokenValue}
          onChange={(e) =>
            onChange({
              ...state,
              validated: false,
              credentials: {
                ...state.credentials,
                accessToken: e.target.value,
              },
            })
          }
          placeholder="Access Token"
          className={cn(
            "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500",
            "focus:border-rv-accent-500 focus:outline-none",
          )}
        />
        {tokenPreview && (
          <p className="text-[11px] text-rv-mute-500">{tokenPreview}</p>
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
          onClick={() => void handleValidate()}
          disabled={validate.isPending || !idValue || !tokenValue}
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
