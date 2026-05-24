import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/new")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
