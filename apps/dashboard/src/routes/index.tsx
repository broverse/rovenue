import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ProjectSummary } from "@rovenue/shared";
import { getSession } from "../lib/auth";
import { ApiError, rpc, unwrap } from "../lib/api";
import { queryClient } from "../lib/queryClient";

export type LandingTarget =
  | { kind: "setup" }
  | { kind: "project"; projectId: string; wroteLastProjectId: boolean };

export function resolveLandingTarget(projects: ProjectSummary[]): LandingTarget {
  if (projects.length === 0) return { kind: "setup" };

  const stored =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;
  const matched = stored && projects.find((p) => p.id === stored)?.id;
  if (matched) {
    return { kind: "project", projectId: matched, wroteLastProjectId: false };
  }

  const fallback = projects[0]!.id;
  try {
    localStorage.setItem("lastProjectId", fallback);
  } catch {
    // ignore quota / private mode
  }
  return { kind: "project", projectId: fallback, wroteLastProjectId: true };
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { error: undefined } });
    }

    let res: { projects: ProjectSummary[] };
    try {
      res = await queryClient.ensureQueryData({
        queryKey: ["projects"],
        queryFn: () =>
          unwrap<{ projects: ProjectSummary[] }>(rpc.dashboard.projects.$get()),
      });
    } catch (err) {
      const expired = err instanceof ApiError && err.status === 401;
      console.error("[/] failed to load projects", err);
      throw redirect({
        to: "/login",
        search: { error: expired ? "session_expired" : "load_failed" },
      });
    }

    const target = resolveLandingTarget(res.projects);
    if (target.kind === "setup") {
      throw redirect({ to: "/projects/setup" });
    }
    throw redirect({
      to: "/projects/$projectId",
      params: { projectId: target.projectId },
    });
  },
});
