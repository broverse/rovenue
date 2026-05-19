import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateProjectRequest, CreateProjectResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      unwrap<CreateProjectResponse>(rpc.dashboard.projects.$post({ json: body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
