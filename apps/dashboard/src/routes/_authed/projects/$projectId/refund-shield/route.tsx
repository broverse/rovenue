import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield",
)({
  component: () => <Outlet />,
});
