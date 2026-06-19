import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreditsRollupResponse,
  GrantCreditsRequest,
  GrantCreditsResponse,
} from "@rovenue/shared";
import { api } from "../api";

interface Params {
  projectId: string;
  windowDays?: number;
  currencyCode?: string;
}

export function useProjectCreditsRollup({ projectId, windowDays, currencyCode }: Params) {
  return useQuery({
    queryKey: ["credits", "rollup", projectId, { windowDays, currencyCode }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (windowDays) params.set("windowDays", String(windowDays));
      if (currencyCode) params.set("currencyCode", currencyCode);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return api<CreditsRollupResponse>(
        `/dashboard/projects/${projectId}/credits/rollup${qs}`,
      );
    },
  });
}

export function useGrantCredits(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GrantCreditsRequest) =>
      api<GrantCreditsResponse>(
        `/dashboard/projects/${projectId}/credits`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["credits", "rollup", projectId],
      });
    },
  });
}
