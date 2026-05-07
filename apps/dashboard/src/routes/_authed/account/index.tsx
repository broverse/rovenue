import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/account/")({
  beforeLoad: () => {
    throw redirect({ to: "/account/profile", replace: true });
  },
});
