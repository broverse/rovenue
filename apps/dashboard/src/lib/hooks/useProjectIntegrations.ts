import { useQuery, useMutation, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
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

// ---------------------------------------------------------------------------
// M6.3 — Validate credentials + test-event mutations
// ---------------------------------------------------------------------------

export function useValidateIntegrationCredentials(projectId: string) {
  return useMutation({
    mutationFn: (connectionId: string) =>
      api<{ ok: true } | { ok: false; reason: string }>(
        `/dashboard/projects/${projectId}/integrations/${connectionId}/validate`,
        { method: "POST" },
      ),
  });
}

export function useTestIntegrationEvent(
  projectId: string,
  connectionId: string,
) {
  return useMutation({
    mutationFn: () =>
      api<{
        ok: boolean;
        httpStatus: number;
        responseBody: string;
        errorMessage?: string;
      }>(
        `/dashboard/projects/${projectId}/integrations/${connectionId}/test-event`,
        { method: "POST" },
      ),
  });
}

// ---------------------------------------------------------------------------
// M6.4 — Deliveries infinite query
// ---------------------------------------------------------------------------

export interface IntegrationDeliveryRow {
  id: string;
  connectionId: string;
  outboxEventId: string;
  eventKey: string;
  providerEvent: string | null;
  status: "pending" | "succeeded" | "failed" | "skipped" | "dead_letter";
  attempt: number;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface DeliveriesPage {
  deliveries: IntegrationDeliveryRow[];
  nextCursor: string | null;
}

interface DeliveriesParams {
  status?: string;
  limit?: number;
}

export function useIntegrationDeliveries(
  projectId: string,
  connectionId: string,
  params: DeliveriesParams = {},
) {
  const { status, limit = 50 } = params;
  return useInfiniteQuery({
    queryKey: ["integration-deliveries", projectId, connectionId, params],
    enabled: Boolean(projectId) && Boolean(connectionId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      qs.set("limit", String(limit));
      if (pageParam) qs.set("cursor", pageParam);
      return api<DeliveriesPage>(
        `/dashboard/projects/${projectId}/integrations/${connectionId}/deliveries?${qs.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
