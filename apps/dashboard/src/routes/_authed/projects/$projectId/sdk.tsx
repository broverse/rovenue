import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, BookOpen, KeyRound } from "lucide-react";
import type { ProjectDetail } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import {
  CreateApiKeyDialog,
  DOCS_URL,
  EndpointsCard,
  KeysCard,
  QuickstartCard,
  ResourcesCard,
  SdkHero,
  SdkPackagesGrid,
  WebhookCard,
} from "../../../../components/sdk-api";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/sdk")({
  component: SdkRoute,
});

function SdkRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/sdk" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SdkPage project={project} />;
}

function SdkPage({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);
  // Prefer a production publishable key for the copy-paste snippets, falling
  // back to whatever key exists; null keeps the `rvn_pk_live_…` placeholder.
  const publishableKey =
    project.apiKeys.find((k) => k.environment === "PRODUCTION")?.publicKey ??
    project.apiKeys[0]?.publicKey ??
    null;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("sdkApi.title")}
          </h1>
          <p className="mt-1 text-[12.5px] text-rv-mute-500 sm:text-[13px]">{t("sdkApi.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            <Button variant="flat" size="sm">
              <BookOpen size={13} />
              {t("sdkApi.actions.docs")}
              <ArrowUpRight size={12} />
            </Button>
          </a>
          <Button variant="flat" size="sm" onClick={openCreate}>
            <KeyRound size={13} />
            {t("sdkApi.actions.manageKeys")}
          </Button>
        </div>
      </header>

      <SdkHero onCreateKey={openCreate} />
      <QuickstartCard publishableKey={publishableKey} />
      <KeysCard projectId={project.id} apiKeys={project.apiKeys} onCreateKey={openCreate} />
      <SdkPackagesGrid />

      <div className="grid items-start gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <EndpointsCard />
        <div className="flex flex-col gap-4">
          <WebhookCard
            endpoint={project.webhookUrl}
            hasSecret={project.hasWebhookSecret}
          />
          <ResourcesCard />
        </div>
      </div>

      <CreateApiKeyDialog
        projectId={project.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
