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
// Configured, season-based leaderboards (ROADMAP §12 item 3)
// =============================================================
//
// The dashboard has no build-time dependency on @rovenue/db (see
// apps/dashboard/package.json), so these wire shapes are declared here
// rather than imported — they mirror
// apps/api/src/routes/dashboard/leaderboards.ts and
// packages/db/src/drizzle/schema.ts (the `leaderboards` /
// `leaderboard_seasons` / `leaderboard_standings` tables) field for
// field. Dates cross the wire as ISO strings (Hono JSON-serializes
// Date columns), never Date objects.

export type LeaderboardMetric = "TOP_SPENDERS" | "TOP_CONSUMERS";
export type LeaderboardCadence = "WEEKLY" | "MONTHLY" | "CUSTOM";
export type LeaderboardSeasonStatus = "ACTIVE" | "CLOSED";

export interface ConfiguredLeaderboard {
  id: string;
  projectId: string;
  identifier: string;
  name: string;
  metric: LeaderboardMetric;
  currencyId: string | null;
  cadence: LeaderboardCadence;
  customPeriodDays: number | null;
  timezone: string;
  entryLimit: number;
  anchorAt: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardSeasonRow {
  id: string;
  leaderboardId: string;
  seasonNumber: number;
  startsAt: string;
  /** Exclusive. */
  endsAt: string;
  status: LeaderboardSeasonStatus;
  closedAt: string | null;
  createdAt: string;
}

/** A `/current` (live) standings row — no persisted rank; the caller derives one from array order. */
export interface LeaderboardLiveEntry {
  subscriberId: string;
  /** Decimal-as-string; never routed through a float. */
  score: string;
  eventCount: number;
}

/** A frozen `/seasons/:seasonId/standings` row — rank is persisted, not derived. */
export interface LeaderboardStandingRow extends LeaderboardLiveEntry {
  id: string;
  seasonId: string;
  rank: number;
}

export interface LeaderboardCurrentResponse {
  season: LeaderboardSeasonRow | null;
  entries: LeaderboardLiveEntry[];
}

export interface SeasonStandingsResponse {
  season: LeaderboardSeasonRow;
  standings: LeaderboardStandingRow[];
}

const configuredLeaderboardsRoot = (projectId: string) =>
  `/dashboard/projects/${projectId}/leaderboards`;

const configuredLeaderboardsKey = (projectId: string) =>
  ["leaderboards", "configured", projectId] as const;

export function useConfiguredLeaderboards(projectId: string) {
  return useQuery({
    queryKey: configuredLeaderboardsKey(projectId),
    enabled: Boolean(projectId),
    queryFn: () =>
      api<{ leaderboards: ConfiguredLeaderboard[] }>(
        configuredLeaderboardsRoot(projectId),
      ),
    select: (res) => res.leaderboards,
  });
}

export interface CreateConfiguredLeaderboardVars {
  identifier: string;
  name: string;
  metric: LeaderboardMetric;
  currencyId?: string | null;
  cadence: LeaderboardCadence;
  customPeriodDays?: number | null;
  timezone?: string;
  entryLimit?: number;
  isEnabled?: boolean;
}

export function useCreateConfiguredLeaderboard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConfiguredLeaderboardVars) =>
      api<{ leaderboard: ConfiguredLeaderboard }>(
        configuredLeaderboardsRoot(projectId),
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: configuredLeaderboardsKey(projectId) }),
  });
}

export interface UpdateConfiguredLeaderboardVars {
  name?: string;
  currencyId?: string | null;
  entryLimit?: number;
  timezone?: string;
  isEnabled?: boolean;
}

export function useUpdateConfiguredLeaderboard(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateConfiguredLeaderboardVars) =>
      api<{ leaderboard: ConfiguredLeaderboard }>(
        `${configuredLeaderboardsRoot(projectId)}/${id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: configuredLeaderboardsKey(projectId) }),
  });
}

export function useDeleteConfiguredLeaderboard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(`${configuredLeaderboardsRoot(projectId)}/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: configuredLeaderboardsKey(projectId) }),
  });
}

export function useLeaderboardSeasons(
  projectId: string,
  leaderboardId: string | null,
) {
  return useQuery({
    queryKey: ["leaderboards", "seasons", projectId, leaderboardId],
    enabled: Boolean(projectId && leaderboardId),
    queryFn: () =>
      api<{ seasons: LeaderboardSeasonRow[] }>(
        `${configuredLeaderboardsRoot(projectId)}/${leaderboardId}/seasons`,
      ),
    select: (res) => res.seasons,
  });
}

export function useLeaderboardCurrent(
  projectId: string,
  leaderboardId: string | null,
) {
  return useQuery({
    queryKey: ["leaderboards", "current", projectId, leaderboardId],
    enabled: Boolean(projectId && leaderboardId),
    queryFn: () =>
      api<LeaderboardCurrentResponse>(
        `${configuredLeaderboardsRoot(projectId)}/${leaderboardId}/current`,
      ),
  });
}

export function useSeasonStandings(
  projectId: string,
  seasonId: string | null,
) {
  return useQuery({
    queryKey: ["leaderboards", "standings", projectId, seasonId],
    enabled: Boolean(projectId && seasonId),
    queryFn: () =>
      api<SeasonStandingsResponse>(
        `${configuredLeaderboardsRoot(projectId)}/seasons/${seasonId}/standings`,
      ),
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
