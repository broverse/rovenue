import { useQuery } from "@tanstack/react-query";
import type { MrrDecompositionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectMrrDecomposition({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "mrr-decomposition", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<MrrDecompositionResponse>(
        rpc.dashboard.projects[":projectId"].metrics["mrr-decomposition"].$get({
          param: { projectId },
          query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        }),
      ),
  });
}
