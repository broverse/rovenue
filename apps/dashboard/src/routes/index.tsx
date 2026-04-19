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
    if (lastProjectId) {
      throw redirect({
        to: "/projects/$projectId",
        params: { projectId: lastProjectId },
      });
    }
    throw redirect({ to: "/projects" });
  },
});
