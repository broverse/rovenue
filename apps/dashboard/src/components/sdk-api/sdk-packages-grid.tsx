import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { SDK_PACKAGES } from "./mock-data";
import { SdkPackageCard } from "./sdk-package-card";

export function SdkPackagesGrid() {
  const { t } = useTranslation();

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("sdkApi.packages.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("sdkApi.packages.subtitle")}
          </p>
        </div>
        <a
          href="#"
          className="inline-flex items-center gap-1 text-[12px] text-rv-accent-500 hover:text-rv-accent-400"
        >
          {t("sdkApi.packages.changelog")}
          <ArrowUpRight size={12} />
        </a>
      </header>
      <div className="grid gap-3 px-4 py-4 sm:px-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {SDK_PACKAGES.map((pkg) => (
          <SdkPackageCard key={pkg.id} pkg={pkg} />
        ))}
      </div>
    </section>
  );
}
