import { useState } from "react";
import {
  Link,
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { Chip } from "../../../../../ui/chip";
import { ApiError } from "../../../../../lib/api";
import { useProject } from "../../../../../lib/hooks/useProject";
import {
  useAudiences,
  useDeleteAudience,
} from "../../../../../lib/hooks/useProjectAdmin";
import { siftToConditions } from "../../../../../components/targeting/sift-codec";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences/",
)({
  component: AudiencesRoute,
});

function AudiencesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audiences/",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AudiencesPage projectId={projectId} />;
}

export function AudiencesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: audiences = [], isLoading } = useAudiences(projectId);
  const deleteMutation = useDeleteAudience();
  const navigate = useNavigate();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(t("audiences.delete.confirm", { name }))) {
      return;
    }
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync({ id, projectId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDeleteError(t("audiences.delete.inUse"));
      } else {
        setDeleteError(
          err instanceof Error ? err.message : t("audiences.delete.failed"),
        );
      }
    }
  };

  return (
    <>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("audiences.title", "Audiences")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t(
              "audiences.subtitle",
              "Targeting groups shared between feature flags and experiments. Editing rules invalidates both engines' caches.",
            )}
          </p>
        </div>
        <Button
          variant="solid-primary"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/audiences/new",
              params: { projectId },
            })
          }
        >
          <Plus size={13} />
          {t("audiences.actions.new")}
        </Button>
      </header>

      {deleteError && (
        <div className="mb-3 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {deleteError}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_180px_140px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("audiences.cols.name", "Name")}</span>
          <span>{t("audiences.cols.kind", "Kind")}</span>
          <span>{t("audiences.cols.rulesCount", "Rules")}</span>
          <span>{t("audiences.cols.created", "Created")}</span>
          <span aria-hidden="true" />
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
            const ruleCount = siftToConditions(a.rules).length;
            return (
              <div
                key={a.id}
                className="grid grid-cols-[minmax(0,1fr)_120px_180px_140px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0 hover:bg-rv-c2/40"
              >
                <Link
                  to="/projects/$projectId/audiences/$audienceId"
                  params={{ projectId, audienceId: a.id }}
                  className="min-w-0 cursor-pointer"
                >
                  <div className="truncate font-medium">{a.name}</div>
                  {a.description && (
                    <div className="truncate text-[11px] text-rv-mute-500">
                      {a.description}
                    </div>
                  )}
                </Link>
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
                {a.isDefault ? (
                  <span aria-hidden="true" />
                ) : (
                  <RowMenu
                    onEdit={() =>
                      void navigate({
                        to: "/projects/$projectId/audiences/$audienceId",
                        params: { projectId, audienceId: a.id },
                      })
                    }
                    onDelete={() => void handleDelete(a.id, a.name)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function RowMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block text-right">
      <button
        type="button"
        aria-label={t("audiences.actions.menu")}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-20 mt-1 w-[140px] overflow-hidden rounded-md border border-rv-divider bg-rv-c1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground transition hover:bg-rv-c3"
            >
              <Pencil size={12} className="text-rv-mute-500" />
              {t("audiences.actions.edit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-rv-danger transition hover:bg-rv-danger/10"
            >
              <Trash2 size={12} />
              {t("audiences.actions.delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
