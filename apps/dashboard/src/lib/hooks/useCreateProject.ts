import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateProjectRequest, CreateProjectResponse } from "@rovenue/shared";
import { api } from "../api";

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      api<CreateProjectResponse>("/dashboard/projects", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
