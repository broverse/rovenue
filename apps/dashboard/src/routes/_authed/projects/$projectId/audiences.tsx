import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Chip } from "../../../../ui/chip";
import { useProject } from "../../../../lib/hooks/useProject";
import { useAudiences } from "../../../../lib/hooks/useProjectAdmin";

export const Route = createFileRoute("/_authed/projects/$projectId/audiences")({
  component: AudiencesRoute,
});

function AudiencesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audiences",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AudiencesPage projectId={projectId} />;
}

function AudiencesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: audiences = [], isLoading } = useAudiences(projectId);

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("audiences.title", "Audiences")}
        </h1>
        <p className="mt-1 text-[13px] text-rv-mute-500">
          {t(
            "audiences.subtitle",
            "Targeting groups shared between feature flags and experiments. Editing rules invalidates both engines' caches.",
          )}
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_180px_200px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("audiences.cols.name", "Name")}</span>
          <span>{t("audiences.cols.kind", "Kind")}</span>
          <span>{t("audiences.cols.rulesCount", "Rules")}</span>
          <span>{t("audiences.cols.created", "Created")}</span>
        </div>
        {isLoading && audiences.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : audiences.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t(
              "audiences.empty",
              "No audiences yet — defaults are created automatically when needed.",
            )}
          </div>
        ) : (
          audiences.map((a) => {
            const ruleCount = Object.keys(a.rules ?? {}).length;
            return (
              <div
                key={a.id}
                className="grid grid-cols-[minmax(0,1fr)_120px_180px_200px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.name}</div>
                  {a.description && (
                    <div className="truncate text-[11px] text-rv-mute-500">
                      {a.description}
                    </div>
                  )}
                </div>
                <Chip tone={a.isDefault ? "primary" : "default"}>
                  {a.isDefault
                    ? t("audiences.kind.default", "Default")
                    : t("audiences.kind.custom", "Custom")}
                </Chip>
                <span className="font-rv-mono text-rv-mute-500">
                  {ruleCount === 0
                    ? t("audiences.allUsers", "all users")
                    : t("audiences.ruleCount", "{{count}} rule(s)", {
                        count: ruleCount,
                      })}
                </span>
                <span className="font-rv-mono text-rv-mute-500">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
