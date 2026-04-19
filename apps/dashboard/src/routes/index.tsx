import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { error: undefined } });
    }
    const lastProjectId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("lastProjectId")
        : null;
    throw redirect({
      // @ts-expect-error /projects/$projectId route is registered in Task B8
      to: lastProjectId ? "/projects/$projectId" : "/projects",
      params: lastProjectId ? { projectId: lastProjectId } : undefined,
    });
  },
});
