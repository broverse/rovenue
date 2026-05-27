import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { EventToggleList } from "../../../../../components/notifications/event-toggle-list";
import { useProject } from "../../../../../lib/hooks/useProject";
import {
  useProjectNotificationDefaults,
  useUpdateProjectNotificationDefaults,
} from "../../../../../lib/hooks/useProjectNotificationDefaults";

// =============================================================
// /projects/:projectId/settings/notifications
// =============================================================
//
// OWNER + ADMIN editor for the project's notification defaults.
// Reuses EventToggleList in "project-defaults" mode (no
// "Custom"/"Default" badges; every write goes to the project
// defaults JSONB).
//
// The 403 guard is server-side (capability project:settings:write
// on PATCH); the UI surfaces the error string from the API.

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/notifications",
)({
  component: ProjectNotificationsSettingsRoute,
});

function ProjectNotificationsSettingsRoute() {
  const { t } = useTranslation();
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/notifications",
  });

  const project = useProject(projectId);
  const defaults = useProjectNotificationDefaults(projectId);
  const update = useUpdateProjectNotificationDefaults(projectId);

  return (
    <div className="mx-auto w-full max-w-[920px] px-4 pb-12 pt-6 sm:px-7 sm:pb-15 sm:pt-9 lg:px-12 lg:pb-20">
      <div className="mb-7">
        <h1 className="m-0 text-[22px] font-semibold leading-7">
          {t(
            "notifications.projectDefaults.title",
            "Notification defaults",
          )}
        </h1>
        <p className="mt-1 text-[13px] text-rv-mute-500">
          {t(
            "notifications.projectDefaults.description",
            "Set the baseline for every member of {{name}}. Members can still override individual events on their own preferences page.",
            { name: project.data?.name ?? projectId },
          )}
        </p>
      </div>

      {update.error ? (
        <div className="mb-4 rounded-md border border-rv-danger/40 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {update.error instanceof Error
            ? update.error.message
            : String(update.error)}
        </div>
      ) : null}

      <EventToggleList
        mode="project-defaults"
        projectDefaults={defaults.data ?? {}}
        disabled={update.isPending}
        onChange={(eventKey, next) =>
          update.mutate({ [eventKey]: next })
        }
      />
    </div>
  );
}
