import { createFileRoute, Link, Outlet, useParams } from "@tanstack/react-router";
import { Spinner } from "@heroui/react";
import { TopNav } from "../../../../components/layout/TopNav";
import { ProjectSwitcher } from "../../../../components/layout/ProjectSwitcher";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId" });
  const { data: project, isLoading, error } = useProject(projectId);

  if (isLoading) {
    return (
      <>
        <TopNav />
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-8 text-default-500">
          <Spinner />
          <span className="text-sm">Loading project...</span>
        </div>
      </>
    );
  }

  if (error || !project) {
    return (
      <>
        <TopNav />
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div role="alert" className="rounded-lg border border-default-200 p-6 text-default-500">
            Project not found.
          </div>
        </div>
      </>
    );
  }

  const activeLinkProps = { className: "font-semibold text-primary" };

  return (
    <>
      <TopNav />
      <div className="border-b border-default-200 bg-content1">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-6">
          <ProjectSwitcher currentProjectId={project.id} />
          <nav className="flex items-center gap-4 text-sm text-default-600">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              activeOptions={{ exact: true }}
              activeProps={activeLinkProps}
            >
              Overview
            </Link>
            <Link
              to="/projects/$projectId/subscribers"
              params={{ projectId: project.id }}
              activeProps={activeLinkProps}
            >
              Subscribers
            </Link>
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              activeProps={activeLinkProps}
            >
              Settings
            </Link>
          </nav>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </div>
    </>
  );
}
