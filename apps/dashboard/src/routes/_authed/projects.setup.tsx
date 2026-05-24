import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ProjectSetupWizard } from "../../components/project-setup";
import type { SetupForm } from "../../components/project-setup";
import { useCreateProject } from "../../lib/hooks/useCreateProject";

export const Route = createFileRoute("/_authed/projects/setup")({
  component: ProjectSetupCreate,
});

function ProjectSetupCreate() {
  const navigate = useNavigate();
  const createProject = useCreateProject();

  const lastProjectId =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;

  const handleCancel = lastProjectId
    ? () => {
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: lastProjectId },
        });
      }
    : undefined;

  const handleSubmit = (form: SetupForm) => {
    createProject.mutate(
      { name: form.name, slug: form.slug },
      {
        onSuccess: (result) => {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("lastProjectId", result.project.id);
          }
          navigate({
            to: "/projects/$projectId",
            params: { projectId: result.project.id },
          });
        },
      },
    );
  };

  return (
    <ProjectSetupWizard
      mode="create"
      onSubmit={handleSubmit}
      isSubmitting={createProject.isPending}
      onCancel={handleCancel}
    />
  );
}
