import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

export interface UserChannels {
  email: boolean;
  push: boolean;
  locale: string;
  timezone: string;
}

export interface PreferencesView {
  channels: UserChannels;
  projectId: string | null;
  projectDefaults: Record<string, boolean>;
  userOverrides: Record<string, boolean>;
}

export type GlobalPrefsPatch = {
  scope: "global";
  channels?: Partial<Pick<UserChannels, "email" | "push">>;
  locale?: string;
  timezone?: string;
};

export type ProjectPrefsPatch = {
  scope: "project";
  projectId: string;
  overrides: Record<string, boolean>;
};

export type PrefsPatch = GlobalPrefsPatch | ProjectPrefsPatch;

const KEY = ["notifications", "preferences"] as const;

export function useNotificationPreferences(projectId?: string) {
  return useQuery({
    queryKey: [...KEY, projectId ?? null],
    queryFn: () => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      return api<PreferencesView>(`/dashboard/notifications/preferences${qs}`);
    },
  });
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PrefsPatch) =>
      api<{ ok: boolean }>(`/dashboard/notifications/preferences`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
