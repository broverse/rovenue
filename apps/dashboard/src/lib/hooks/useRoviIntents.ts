import { useMutation } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../api";

// Backend executes the original action and returns its result envelope.
// The shape varies per tool (transfer / grant / refund / …) so we keep
// it as `unknown` here and let callers narrow when they need to.
type IntentExecuteResult = unknown;
type IntentRejectResult = { id: string; status: "rejected" };

export function useRoviIntents() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };

  const execute = useMutation({
    mutationFn: (intentId: string) =>
      api<IntentExecuteResult>(
        `/dashboard/projects/${projectId}/copilot/intents/${intentId}/execute`,
        { method: "POST" },
      ),
  });

  const reject = useMutation({
    mutationFn: (intentId: string) =>
      api<IntentRejectResult>(
        `/dashboard/projects/${projectId}/copilot/intents/${intentId}/reject`,
        { method: "POST" },
      ),
  });

  return { execute, reject };
}
