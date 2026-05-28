import { useTranslation } from "react-i18next";
import { AppCard } from "./app-card";
import type { AppDescriptor, CategoryId } from "./types";

type Props = {
  category: CategoryId;
  apps: ReadonlyArray<AppDescriptor>;
  totalCount: number;
  onViewAll: (category: CategoryId) => void;
  onSelect?: (id: string) => void;
  onOpenIntegration?: (providerId: string) => void;
};

export function AppsSection({ category, apps, totalCount, onViewAll, onSelect, onOpenIntegration }: Props) {
  const { t } = useTranslation();
  if (apps.length === 0) return null;
  return (
    <section>
      <div className="mt-5 mb-2.5 flex flex-wrap items-baseline gap-2.5">
        <h3 className="text-[14px] font-semibold text-foreground">
          {t(`apps.sections.${category}.title`)}
        </h3>
        <span className="text-[11.5px] text-rv-mute-500">
          {t(`apps.sections.${category}.subtitle`)}
        </span>
        <button
          type="button"
          onClick={() => onViewAll(category)}
          className="ml-auto cursor-pointer text-[11.5px] text-rv-accent-400 hover:underline"
        >
          {t("apps.section.viewAll", { count: totalCount })}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
        {apps.map((app) => (
          <AppCard key={app.id} app={app} onSelect={onSelect} onOpenIntegration={onOpenIntegration} />
        ))}
      </div>
    </section>
  );
}
