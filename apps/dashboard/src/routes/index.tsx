import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) {
      // @ts-expect-error /login route is registered in Task B5
      throw redirect({ to: "/login" });
    }
    const lastProjectId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("lastProjectId")
        : null;
    throw redirect({
      // @ts-expect-error /projects route is registered in Task B7
      to: lastProjectId ? "/projects/$projectId" : "/projects",
      // @ts-expect-error /projects route is registered in Task B7
      params: lastProjectId ? { projectId: lastProjectId } : undefined,
    });
  },
});
