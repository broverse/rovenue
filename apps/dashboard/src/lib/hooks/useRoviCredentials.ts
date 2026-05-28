import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../api";

export type RoviCredentials = {
  provider: "openai" | "anthropic" | "mistral" | "ollama" | null;
  defaultModel: string | null;
  baseUrl: string | null;
  hasKey: boolean;
  updatedAt: string | null;
};

export type RoviCredentialsUpsertInput = {
  provider: "openai" | "anthropic" | "mistral" | "ollama";
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
};

export function useRoviCredentials() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const qc = useQueryClient();
  const queryKey = ["rovi-credentials", projectId] as const;

  const query = useQuery({
    enabled: Boolean(projectId),
    queryKey,
    queryFn: () =>
      api<RoviCredentials>(
        `/dashboard/projects/${projectId}/copilot/credentials`,
      ),
    staleTime: 30_000,
  });

  const upsert = useMutation({
    mutationFn: (input: RoviCredentialsUpsertInput) =>
      api<{ saved: true }>(
        `/dashboard/projects/${projectId}/copilot/credentials`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: true; model: string }>(
        `/dashboard/projects/${projectId}/copilot/credentials/test`,
        { method: "POST" },
      ),
  });

  return { query, upsert, test };
}
