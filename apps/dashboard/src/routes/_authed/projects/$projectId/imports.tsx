import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ImportsPage } from "../../../../components/imports";

export const Route = createFileRoute("/_authed/projects/$projectId/imports")({
  component: ImportsRoute,
});

function ImportsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/imports",
  });
  const { t } = useTranslation();

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("imports.title", "Data import")}
          </h1>
          <p className="mt-1 text-[12.5px] text-rv-mute-500 sm:text-[13px]">
            {t(
              "imports.subtitle",
              "Bring subscriber history in from RevenueCat, Adapty, or a plain CSV export.",
            )}
          </p>
        </div>
      </header>

      <ImportsPage projectId={projectId} />
    </>
  );
}
