import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ProjectSetupWizard } from "../../components/project-setup";
import type { SetupForm } from "../../components/project-setup";
import { useCreateProject } from "../../lib/hooks/useCreateProject";
import { api } from "../../lib/api";

export const Route = createFileRoute("/_authed/projects/setup")({
  component: ProjectSetupCreate,
});

/**
 * Push the Apple store credentials we have from the wizard. The
 * full set (private key .p8 + appAppleId) lives on the project's
 * own settings page later — bundleId on its own is enough for the
 * backend to mark the credential row as configured.
 *
 * The credentials handler uses per-`:store` zod dispatch instead of
 * a static zValidator middleware, so Hono RPC can't infer a body
 * type for it. We fall through to the path-based `api()` helper to
 * keep the call out of the RPC's type surface.
 */
async function pushAppleCredentials(projectId: string, form: SetupForm) {
  if (!form.platforms.includes("ios") || !form.bundleId.trim()) return;
  const body: Record<string, string> = { bundleId: form.bundleId.trim() };
  if (form.storeKeyId.trim()) body.keyId = form.storeKeyId.trim();
  if (form.storeIssuer.trim()) body.issuerId = form.storeIssuer.trim();
  await api(`/dashboard/projects/${projectId}/credentials/apple`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

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
      {
        name: form.name,
        description: form.desc.trim() ? form.desc.trim() : null,
        reporting: {
          reportingCurrency: form.currency,
          fxSource: "ecb",
          timezone: form.timezone,
          weekStart: form.weekStart,
          fiscalMonth: form.fiscalMonth,
        },
      },
      {
        onSuccess: async (result) => {
          const projectId = result.project.id;
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("lastProjectId", projectId);
          }
          // Apple bundleId is the only credential the wizard can
          // currently produce a valid backend payload for; google &
          // stripe both require uploads / OAuth and remain TODO on
          // the project's own settings page. We swallow failures so a
          // half-filled iOS field doesn't strand the user on the
          // wizard — they can retry from the credentials page.
          try {
            await pushAppleCredentials(projectId, form);
          } catch (err) {
            console.warn("Apple credentials skipped:", err);
          }
          void navigate({
            to: "/projects/$projectId/settings/members",
            params: { projectId },
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
