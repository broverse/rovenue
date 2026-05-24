import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
