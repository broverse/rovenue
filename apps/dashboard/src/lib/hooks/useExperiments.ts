import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  DeleteExperimentResponse,
  DuplicateExperimentResponse,
  ExperimentDetailResponse,
  ExperimentLifecycleResponse,
  ExperimentListResponse,
  ExperimentListItem,
  StopExperimentRequest,
} from "@rovenue/shared";
import { api, rpc, unwrap } from "../api";

export interface CreateExperimentVars {
  projectId: string;
  name: string;
  description?: string;
  type: DashboardExperimentType;
  key: string;
  audienceId: string;
  variants: ReadonlyArray<{
    id: string;
    name: string;
    value: unknown;
    weight: number;
  }>;
  metrics?: ReadonlyArray<string>;
  mutualExclusionGroup?: string;
}

interface ListParams {
  projectId: string;
  status?: DashboardExperimentStatus;
  type?: DashboardExperimentType;
}

export function useExperiments({ projectId, status, type }: ListParams) {
  return useQuery({
    queryKey: ["experiments", projectId, { status, type }],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<ExperimentListResponse>(
        rpc.dashboard.experiments.$get({
          query: {
            projectId,
            ...(status ? { status } : {}),
            ...(type ? { type } : {}),
          },
        }),
      ),
    select: (res) => res.experiments,
  });
}

export function useExperiment(id: string | undefined) {
  return useQuery({
    queryKey: ["experiment", id],
    enabled: Boolean(id),
    queryFn: () =>
      unwrap<ExperimentDetailResponse>(
        rpc.dashboard.experiments[":id"].$get({ param: { id: id! } }),
      ),
  });
}

// =============================================================
// Lifecycle mutations
// =============================================================
//
// Each mutation invalidates the project's experiment list so the
// status dots + scope counts refresh, plus the specific detail
// query for the experiment it touched.

type LifecycleVerb = "start" | "pause" | "resume";

function lifecycleAction(action: LifecycleVerb) {
  return (id: string) =>
    unwrap<ExperimentLifecycleResponse>(
      rpc.dashboard.experiments[":id"][action].$post({ param: { id } }),
    );
}

function useLifecycleMutation(
  mutationFn: (id: string) => Promise<ExperimentLifecycleResponse>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["experiment", data.experiment.id] });
    },
  });
}

export function useCreateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateExperimentVars) => {
      const { metrics, variants, ...rest } = vars;
      return unwrap<{ experiment: ExperimentListItem }>(
        rpc.dashboard.experiments.$post({
          json: {
            ...rest,
            variants: variants.map((v) => ({ ...v })),
            ...(metrics ? { metrics: [...metrics] } : {}),
          },
        }),
      );
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["experiments", vars.projectId] });
    },
  });
}

export interface UpdateDraftExperimentVars {
  id: string;
  name?: string;
  description?: string | null;
  type?: DashboardExperimentType;
  key?: string;
  audienceId?: string;
  variants?: ReadonlyArray<{
    id: string;
    name: string;
    value: unknown;
    weight: number;
  }>;
}

export function useUpdateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateDraftExperimentVars) => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.description !== undefined) body.description = patch.description;
      if (patch.type !== undefined) body.type = patch.type;
      if (patch.key !== undefined) body.key = patch.key;
      if (patch.audienceId !== undefined) body.audienceId = patch.audienceId;
      if (patch.variants !== undefined) {
        body.variants = patch.variants.map((v) => ({ ...v }));
      }
      // The backend PATCH handler parses the body itself (status-aware
      // schema discrimination) so there's no static `json` shape on
      // the RPC type — fall back to the raw `api()` helper.
      return api<{ experiment: ExperimentListItem }>(
        `/dashboard/experiments/${id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["experiment", data.experiment.id] });
    },
  });
}

export function useStartExperiment() {
  return useLifecycleMutation(lifecycleAction("start"));
}

export function usePauseExperiment() {
  return useLifecycleMutation(lifecycleAction("pause"));
}

export function useResumeExperiment() {
  return useLifecycleMutation(lifecycleAction("resume"));
}

export interface StopExperimentVars {
  id: string;
  body?: StopExperimentRequest;
}

export function useStopExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: StopExperimentVars) =>
      unwrap<ExperimentLifecycleResponse>(
        rpc.dashboard.experiments[":id"].stop.$post({
          param: { id },
          ...(body ? { json: body } : { json: {} }),
        }),
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["experiment", data.experiment.id] });
      if (data.promotedFlag) {
        qc.invalidateQueries({ queryKey: ["feature-flags"] });
      }
    },
  });
}

export function useDeleteExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<DeleteExperimentResponse>(
        rpc.dashboard.experiments[":id"].$delete({ param: { id } }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
    },
  });
}

export function useDuplicateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<DuplicateExperimentResponse>(
        rpc.dashboard.experiments[":id"].duplicate.$post({ param: { id } }),
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({
        queryKey: ["experiments", data.experiment.projectId],
      });
    },
  });
}

export type { ExperimentListItem };
