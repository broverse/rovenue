import { useNavigate } from "@tanstack/react-router";

const ROUTE_MAP: Record<string, string> = {
  overview: "/projects/$projectId",
  subscribers: "/projects/$projectId/subscribers",
  subscriptions: "/projects/$projectId/subscriptions",
  products: "/projects/$projectId/products",
  audiences: "/projects/$projectId/audiences",
  experiments: "/projects/$projectId/experiments",
  featureFlags: "/projects/$projectId/feature-flags",
  transactions: "/projects/$projectId/transactions",
};

export function NavigateCard({
  projectId,
  output,
}: {
  projectId: string;
  output: {
    uiAction: "navigate" | "openSubscriber" | string;
    to?: string;
    id?: string;
  };
}) {
  const navigate = useNavigate();

  function go() {
    if (output.uiAction === "openSubscriber" && output.id) {
      navigate({
        to: "/projects/$projectId/subscribers/$id" as never,
        params: { projectId, id: output.id } as never,
      });
      return;
    }
    if (output.uiAction === "navigate" && output.to) {
      const to = ROUTE_MAP[output.to];
      if (to) {
        navigate({ to: to as never, params: { projectId } as never });
      }
    }
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
      <span className="text-foreground">
        Go to <span className="font-medium">{output.to ?? output.id}</span>
      </span>
      <button
        type="button"
        onClick={go}
        className="h-7 rounded-md bg-rv-c4 px-2.5 text-foreground transition hover:opacity-90"
      >
        Open
      </button>
    </div>
  );
}
