import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import { useProjects } from "../../lib/hooks/useProjects";
import { IconChevronDown } from "./icons";

type AppSwitcherProps = {
  projectId: string;
  projectName: string;
  /** Short label shown below the project name (env / platform). */
  envLabel?: string;
};

/**
 * Sidebar header — current project icon, name, env. Click reveals a Base UI
 * menu to switch between projects the user has access to.
 */
export function AppSwitcher({ projectId, projectName, envLabel = "prod" }: AppSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const initial = projectName.charAt(0).toUpperCase();

  return (
    <Menu.Root>
      <Menu.Trigger
        className="group flex h-14 w-full cursor-pointer items-center gap-2.5 border-b border-rv-divider px-3 transition hover:bg-rv-c2"
        title={t("appSwitcher.switchProject")}
      >
        <div className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-500 to-rv-accent-700 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.15)]">
          {initial}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[13px] font-semibold text-foreground">{projectName}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-rv-mute-500">
            <span className="size-1.5 rounded-full bg-rv-success shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-success)_20%,transparent)]" />
            {envLabel}
          </div>
        </div>
        <IconChevronDown size={14} className="text-rv-mute-500" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="start" className="z-50 w-[var(--anchor-width)]">
          <Menu.Popup className="min-w-[200px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-rv-mute-500">
              {t("appSwitcher.projects")}
            </div>
            {projects?.map((p) => (
              <Menu.Item
                key={p.id}
                onClick={() => {
                  if (p.id === projectId) return;
                  try {
                    localStorage.setItem("lastProjectId", p.id);
                  } catch {
                    /* ignore quota / private mode */
                  }
                  void navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
              >
                <span className="flex size-5 items-center justify-center rounded bg-gradient-to-br from-rv-accent-500 to-rv-accent-700 text-[10px] font-semibold text-white">
                  {p.name.charAt(0).toUpperCase()}
                </span>
                <span className="flex-1 truncate">{p.name}</span>
                {p.id === projectId && (
                  <span className="text-[11px] text-rv-accent-500">{t("common.current")}</span>
                )}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
