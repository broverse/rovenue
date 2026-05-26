import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AssignableRole,
  AudienceRow,
  AudiencesListResponse,
  AuditLogsListResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  LeaderboardResponse,
  ListInvitationsResponse,
  ListMembersResponse,
  ProjectMemberRow,
  TransferOwnershipRequest,
  UpdateMemberRoleRequest,
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

// =============================================================
// Member management mutations
// =============================================================

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      userId,
      role,
    }: {
      projectId: string;
      userId: string;
      role: AssignableRole;
    }) =>
      api<{ member: ProjectMemberRow }>(
        `/dashboard/projects/${projectId}/members/${userId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ role } satisfies UpdateMemberRoleRequest),
        },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      userId,
    }: {
      projectId: string;
      userId: string;
    }) =>
      api(`/dashboard/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

export function useLeaveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      api(`/dashboard/projects/${projectId}/members/leave`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useTransferOwnership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      toUserId,
    }: {
      projectId: string;
      toUserId: string;
    }) =>
      api(`/dashboard/projects/${projectId}/members/transfer`, {
        method: "POST",
        body: JSON.stringify({ toUserId } satisfies TransferOwnershipRequest),
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

// =============================================================
// Invitations
// =============================================================

export function useProjectInvitations(projectId: string) {
  return useQuery({
    queryKey: ["invitations", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListInvitationsResponse>(
        `/dashboard/projects/${projectId}/invitations`,
      ),
    select: (res) => res.invitations,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      email,
      role,
    }: { projectId: string } & CreateInvitationRequest) =>
      api<CreateInvitationResponse>(
        `/dashboard/projects/${projectId}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({ email, role } satisfies CreateInvitationRequest),
        },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      invitationId,
    }: {
      projectId: string;
      invitationId: string;
    }) =>
      api(`/dashboard/projects/${projectId}/invitations/${invitationId}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}

export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      invitationId,
    }: {
      projectId: string;
      invitationId: string;
    }) =>
      api(`/dashboard/projects/${projectId}/invitations/${invitationId}/resend`, {
        method: "POST",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}

// =============================================================
// Audiences (single + mutations)
// =============================================================

export function useAudience(id: string | undefined) {
  return useQuery({
    queryKey: ["audience", id],
    enabled: Boolean(id),
    queryFn: () =>
      api<{ audience: AudienceRow }>(
        `/dashboard/audiences/${encodeURIComponent(id!)}`,
      ),
    select: (res) => res.audience,
  });
}

export interface CreateAudienceVars {
  projectId: string;
  name: string;
  description?: string;
  rules: Record<string, unknown>;
}

export function useCreateAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateAudienceVars) =>
      api<{ audience: AudienceRow }>("/dashboard/audiences", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
    },
  });
}

export interface UpdateAudienceVars {
  id: string;
  projectId: string;
  name?: string;
  description?: string | null;
  rules?: Record<string, unknown>;
}

export function useUpdateAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId: _p, ...patch }: UpdateAudienceVars) =>
      api<{ audience: AudienceRow }>(
        `/dashboard/audiences/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
      qc.invalidateQueries({ queryKey: ["audience", vars.id] });
    },
  });
}

export interface DeleteAudienceVars {
  id: string;
  projectId: string;
}

export function useDeleteAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: DeleteAudienceVars) =>
      api<{ deleted: true }>(
        `/dashboard/audiences/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
    },
  });
}
