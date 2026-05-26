import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  ExperimentDetailResponse,
  ExperimentLifecycleResponse,
  ExperimentListResponse,
  ExperimentListItem,
  StopExperimentRequest,
} from "@rovenue/shared";
import { rpc, unwrap } from "../api";

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

export type { ExperimentListItem };
