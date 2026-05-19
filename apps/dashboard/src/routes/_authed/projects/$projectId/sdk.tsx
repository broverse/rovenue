import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, BookOpen, KeyRound } from "lucide-react";
import type { ProjectDetail } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import {
  EndpointsCard,
  HERO_STATS,
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
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("sdkApi.actions.docs")}
            <ArrowUpRight size={12} />
          </Button>
          <Button variant="flat" size="sm">
            <KeyRound size={13} />
            {t("sdkApi.actions.manageKeys")}
          </Button>
        </div>
      </header>

      <SdkHero stats={HERO_STATS} />
      <QuickstartCard />
      <KeysCard apiKeys={project.apiKeys} />
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
    </>
  );
}
