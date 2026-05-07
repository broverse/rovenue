import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { Button } from "../../ui/button";
import { AppLogo } from "./app-logo";
import { APPS, FEATURED_RECIPE } from "./mock-data";

const bannerStyle: CSSProperties = {
  background: [
    "radial-gradient(circle at 15% 30%, color-mix(in srgb, var(--color-rv-accent-500) 22%, transparent), transparent 50%)",
    "radial-gradient(circle at 85% 70%, color-mix(in srgb, #A78BFA 18%, transparent), transparent 50%)",
    "var(--color-rv-c1)",
  ].join(", "),
};

export function FeaturedRecipeBanner() {
  const { t } = useTranslation();
  const apps = FEATURED_RECIPE.appIds
    .map((id) => APPS.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  return (
    <section
      style={bannerStyle}
      className="mb-4 grid grid-cols-1 items-center gap-4 rounded-[10px] border border-rv-divider px-4 py-4 sm:gap-5 sm:px-6 sm:py-5 lg:grid-cols-[1fr_auto]"
    >
      <div>
        <div className="font-rv-mono text-[11px] font-medium uppercase tracking-wider text-rv-accent-400">
          {t("apps.featured.eyebrow")}
        </div>
        <h3 className="mt-1.5 text-[16px] font-semibold leading-snug text-foreground sm:text-[18px]">
          {t("apps.featured.title")}
        </h3>
        <p className="mt-1.5 max-w-[540px] text-[12.5px] leading-[1.55] text-rv-mute-600">
          {t("apps.featured.description")}
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button variant="solid-primary" size="sm">
            {t("apps.featured.install")}
          </Button>
          <Button variant="flat" size="sm">
            {t("apps.featured.guide")}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {apps.map((app) => (
          <AppLogo key={app.id} logo={app.logo} size="lg" />
        ))}
      </div>
    </section>
  );
}
