import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../api";

export type RoviUsage = {
  tier: "free" | "team" | "business" | "enterprise";
  unlimited: boolean;
  period: { start: string; end: string; daysLeft: number };
  messages: { used: number; limit: number | null; percent: number };
  tokens: {
    input: { used: number; limit: number | null };
    output: { used: number; limit: number | null };
  };
  resetAt: string;
};

export function useRoviUsage() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  return useQuery({
    enabled: Boolean(projectId),
    queryKey: ["rovi-usage", projectId],
    queryFn: () =>
      api<RoviUsage>(`/dashboard/projects/${projectId}/copilot/usage`),
    staleTime: 60_000,
  });
}
