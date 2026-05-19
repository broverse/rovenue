import { useQuery } from "@tanstack/react-query";
import type { CreditsRollupResponse } from "@rovenue/shared";
import { api } from "../api";

interface Params {
  projectId: string;
  windowDays?: number;
}

export function useProjectCreditsRollup({ projectId, windowDays }: Params) {
  return useQuery({
    queryKey: ["credits", "rollup", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const qs = windowDays ? `?windowDays=${windowDays}` : "";
      return api<CreditsRollupResponse>(
        `/dashboard/projects/${projectId}/credits/rollup${qs}`,
      );
    },
  });
}
