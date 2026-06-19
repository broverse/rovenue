import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Store } from "lucide-react";
import type { CredentialStore } from "@rovenue/shared";
import { StoreCredentialCard } from "../../../../components/stores";
import { LoadingState } from "../../../../components/dashboard/loading-state";
import { EmptyStateCard } from "../../../../components/dashboard/empty-state-card";
import { useProjectCredentials } from "../../../../lib/hooks/useProjectCredentials";
import { useProjects } from "../../../../lib/hooks/useProjects";

export const Route = createFileRoute("/_authed/projects/$projectId/stores")({
  component: StoresRoute,
});

const STORES: CredentialStore[] = ["apple", "google", "stripe"];

function StoresRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/stores" });
  return <StoresPage projectId={projectId} />;
}

function StoresPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const credentials = useProjectCredentials(projectId);
  // Writes are OWNER-only on the server; reflect that in the UI so non-owners
  // see status read-only instead of hitting a 403 on save.
  const projects = useProjects();
  const role = projects.data?.find((p) => p.id === projectId)?.role;
  const canEdit = role === "OWNER";

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
          {t("stores.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[12.5px] text-rv-mute-500 sm:text-[13px]">
          {t("stores.subtitle")}
        </p>
      </header>

      {credentials.isLoading ? (
        <LoadingState />
      ) : credentials.isError || !credentials.data ? (
        <EmptyStateCard
          icon={Store}
          title={t("stores.loadError")}
          description={t("stores.loadErrorHint")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {STORES.map((store) => (
            <StoreCredentialCard
              key={store}
              projectId={projectId}
              store={store}
              status={credentials.data.credentials[store]}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
    </>
  );
}
