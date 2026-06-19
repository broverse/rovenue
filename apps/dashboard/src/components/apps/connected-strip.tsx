import { useTranslation } from "react-i18next";
import { AppLogo } from "./app-logo";
import type { AppDescriptor } from "./types";

type Props = {
  apps: ReadonlyArray<AppDescriptor>;
};

export function ConnectedStrip({ apps }: Props) {
  const { t } = useTranslation();
  if (apps.length === 0) return null;
  return (
    <section className="mb-3.5 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5 sm:px-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">
          {t("apps.connected.title", { count: apps.length })}
        </h3>
      </header>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
        {apps.map((app) => (
          <div
            key={app.id}
            className="flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5"
          >
            <AppLogo logo={app.logo} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium text-foreground">
                {t(`apps.items.${app.id}.name`)}
              </div>
              <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
                {app.account ?? "—"} · {app.lastSync ?? "—"}
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded bg-rv-success/14 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-success">
              <span className="h-1 w-1 rounded-full bg-rv-success shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-success)_30%,transparent)]" />
              {t("apps.connected.ok")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
