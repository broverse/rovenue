import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AudiencesListResponse,
  AuditLogsListResponse,
  LeaderboardResponse,
  ListMembersResponse,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Audit logs (offset-paginated)
// =============================================================

interface AuditLogParams {
  projectId: string;
  limit?: number;
}

export function useAuditLogs({ projectId, limit = 50 }: AuditLogParams) {
  return useInfiniteQuery<AuditLogsListResponse>({
    queryKey: ["audit-logs", projectId, { limit }],
    enabled: Boolean(projectId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ projectId });
      params.set("limit", String(limit));
      params.set("offset", String(pageParam));
      return api<AuditLogsListResponse>(
        `/dashboard/audit-logs?${params.toString()}`,
      );
    },
    getNextPageParam: (last) =>
      last.pagination.hasMore
        ? last.pagination.offset + last.pagination.limit
        : undefined,
  });
}

// =============================================================
// Audiences
// =============================================================

export function useAudiences(projectId: string) {
  return useQuery({
    queryKey: ["audiences", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<AudiencesListResponse>(
        `/dashboard/audiences?projectId=${encodeURIComponent(projectId)}`,
      ),
    select: (res) => res.audiences,
  });
}

// =============================================================
// Leaderboards
// =============================================================

interface LeaderboardParams {
  projectId: string;
  /** ISO date — required by the API (YYYY-MM-DD or full ISO). */
  from: string;
  to: string;
  limit?: number;
}

export function useTopSpenders({
  projectId,
  from,
  to,
  limit = 10,
}: LeaderboardParams) {
  return useQuery({
    queryKey: ["leaderboards", "top-spenders", projectId, { from, to, limit }],
    enabled: Boolean(projectId && from && to),
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: String(limit) });
      return api<LeaderboardResponse>(
        `/dashboard/projects/${projectId}/leaderboards/top-spenders?${params.toString()}`,
      );
    },
  });
}

export function useTopConsumers({
  projectId,
  from,
  to,
  limit = 10,
}: LeaderboardParams) {
  return useQuery({
    queryKey: ["leaderboards", "top-consumers", projectId, { from, to, limit }],
    enabled: Boolean(projectId && from && to),
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: String(limit) });
      return api<LeaderboardResponse>(
        `/dashboard/projects/${projectId}/leaderboards/top-consumers?${params.toString()}`,
      );
    },
  });
}

// =============================================================
// Members
// =============================================================

export function useProjectMembers(projectId: string) {
  return useQuery({
    queryKey: ["members", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListMembersResponse>(`/dashboard/projects/${projectId}/members`),
    select: (res) => res.members,
  });
}
