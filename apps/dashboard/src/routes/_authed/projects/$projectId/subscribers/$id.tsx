import { createFileRoute, useParams } from "@tanstack/react-router";
import { Spinner } from "@heroui/react";
import { useSubscriber } from "../../../../../lib/hooks/useSubscriber";
import { SubscriberDetailPanel } from "../../../../../components/subscribers/SubscriberDetailPanel";

export const Route = createFileRoute("/_authed/projects/$projectId/subscribers/$id")({
  component: SubscriberDetailRouteComponent,
});

function SubscriberDetailRouteComponent() {
  const { projectId, id } = useParams({ from: "/_authed/projects/$projectId/subscribers/$id" });
  return <SubscriberDetailPage projectId={projectId} id={id} />;
}

export function SubscriberDetailPage({
  projectId,
  id,
}: {
  projectId: string;
  id: string;
}) {
  const { data, isLoading, error } = useSubscriber(projectId, id);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-default-500">
        <Spinner /> <span className="text-sm">Loading...</span>
      </div>
    );
  }
  if (error) return <div className="text-danger-500">{error.message}</div>;
  if (!data) return null;
  return <SubscriberDetailPanel data={data} />;
}
