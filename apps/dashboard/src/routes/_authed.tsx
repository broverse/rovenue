import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) throw redirect({ to: "/login", search: { error: undefined } });
  },
  component: Outlet,
});
