import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { RESOURCES } from "./mock-data";

export function ResourcesCard() {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-5 py-4">
        <h3 className="text-[14px] font-semibold leading-5 text-foreground">
          {t("sdkApi.resources.title")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
          {t("sdkApi.resources.subtitle")}
        </p>
      </header>
      <ul className="grid gap-2 px-5 py-4 sm:grid-cols-2">
        {RESOURCES.map((resource) => {
          const Icon = resource.icon;
          return (
            <li key={resource.id}>
              <a
                href={resource.href}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-start gap-2.5 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5 transition hover:border-rv-divider-strong"
              >
                <span className="mt-0.5 flex size-7 items-center justify-center rounded border border-rv-divider bg-rv-c1 text-rv-mute-700">
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[12.5px] font-medium text-foreground">
                    {t(`sdkApi.resources.items.${resource.labelKey}`)}
                    <ArrowUpRight size={11} className="text-rv-mute-500" />
                  </span>
                  <span className="block text-[11.5px] text-rv-mute-500">
                    {t(`sdkApi.resources.descriptions.${resource.descriptionKey}`)}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
