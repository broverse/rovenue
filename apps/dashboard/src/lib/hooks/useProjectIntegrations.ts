import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

export interface CreateIntegrationBody {
  providerId: "META_CAPI" | "TIKTOK_EVENTS";
  displayName: string;
  credentials: Record<string, string>;
  enabledEvents?: string[];
  eventMapping?: Record<string, { eventName?: string; skip?: true }>;
  actionSource?: "app" | "website" | "system_generated";
  testEventCode?: string | null;
  isEnabled?: boolean;
}

export interface UpdateIntegrationBody {
  displayName?: string;
  credentials?: Record<string, string>;
  enabledEvents?: string[];
  eventMapping?: Record<string, { eventName?: string; skip?: true }>;
  actionSource?: "app" | "website" | "system_generated";
  testEventCode?: string | null;
  isEnabled?: boolean;
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

// ---------------------------------------------------------------------------
// M6.2 — Create / Update / Delete mutations
// ---------------------------------------------------------------------------

export function useCreateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateIntegrationBody) =>
      api<{ id: string }>(
        `/dashboard/projects/${projectId}/integrations`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-integrations", projectId] });
    },
  });
}

export function useUpdateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      body,
    }: {
      connectionId: string;
      body: UpdateIntegrationBody;
    }) =>
      api<IntegrationConnectionRow>(
        `/dashboard/projects/${projectId}/integrations/${connectionId}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-integrations", projectId] });
      void qc.invalidateQueries({ queryKey: ["project-app-connections", projectId] });
    },
  });
}

export function useDeleteIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api<{ deleted: boolean }>(
        `/dashboard/projects/${projectId}/integrations/${connectionId}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project-integrations", projectId] });
      void qc.invalidateQueries({ queryKey: ["project-app-connections", projectId] });
    },
  });
}
