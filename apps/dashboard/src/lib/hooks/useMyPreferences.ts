import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  MyPreferencesResponse,
  UpdatePreferencesRequest,
} from "@rovenue/shared";
import { api } from "../api";

export function useMyPreferences() {
  return useQuery({
    queryKey: ["me", "preferences"],
    queryFn: () =>
      api<MyPreferencesResponse>("/dashboard/me/preferences"),
    select: (res) => res.preferences,
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePreferencesRequest) =>
      api<MyPreferencesResponse>("/dashboard/me/preferences", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["me", "preferences"], data);
    },
  });
}
