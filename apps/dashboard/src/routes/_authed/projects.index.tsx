import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, Spinner } from "@heroui/react";
import { TopNav } from "../../components/layout/TopNav";
import { ProjectCard } from "../../components/projects/ProjectCard";
import { useProjects } from "../../lib/hooks/useProjects";

export const Route = createFileRoute("/_authed/projects/")({
  component: ProjectsList,
});

function ProjectsList() {
  const { data, isLoading, error } = useProjects();

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Projects</h1>
          <Link to="/projects/new">
            <Button variant="primary">New project</Button>
          </Link>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner /> <span className="text-sm">Loading...</span>
          </div>
        )}
        {error && (
          <div role="alert" className="text-danger-500">
            {error.message}
          </div>
        )}
        {data?.length === 0 && (
          <div className="rounded-lg border border-dashed border-default-300 p-12 text-center text-default-500">
            No projects yet. Create your first one to get started.
          </div>
        )}
        {data && data.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
