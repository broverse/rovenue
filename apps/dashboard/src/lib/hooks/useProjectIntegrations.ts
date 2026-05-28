import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrationConnectionRow {
  id: string;
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  displayName: string;
  credentialsHint: string;
  enabledEvents: string[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode: string | null;
  isEnabled: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
  lastBackfillAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// M6.1 — List query
// ---------------------------------------------------------------------------

export function useProjectIntegrations(projectId: string) {
  return useQuery({
    queryKey: ["project-integrations", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<IntegrationConnectionRow[]>(
        `/dashboard/projects/${projectId}/integrations`,
      ),
  });
}
