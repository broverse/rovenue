import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { AppSwitcher } from "./app-switcher";
import { SidebarNavLink } from "./sidebar-nav-link";
import { SidebarNewButton } from "./sidebar-new-button";
import { NAV_SECTIONS } from "./navigation";

type SidebarProps = {
  projectId: string;
  projectName: string;
  envLabel?: string;
  /** Mobile-only drawer state. Ignored at lg+ where the sidebar is always visible. */
  open?: boolean;
  onClose?: () => void;
};

/**
 * Persistent left navigation. Behaves as a fixed slide-in drawer below
 * the lg breakpoint and as a stationary 240px column at lg+.
 */
export function Sidebar({ projectId, projectName, envLabel, open = false, onClose }: SidebarProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside
      aria-label={t("sidebar.primaryAria")}
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex h-screen w-60 flex-col overflow-hidden border-r border-rv-divider bg-rv-c1 transition-transform duration-200 ease-out",
        "lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex items-center border-b border-rv-divider lg:border-b-0">
        <div className="min-w-0 flex-1">
          <AppSwitcher projectId={projectId} projectName={projectName} envLabel={envLabel} />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground lg:hidden"
        >
          <X size={16} />
        </button>
      </div>

      <nav
        className="flex-1 overflow-y-auto px-2 pb-2 pt-3 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]"
      >
        <div className="mb-3 px-1">
          <SidebarNewButton />
        </div>
        {NAV_SECTIONS.map((group, groupIdx) => (
          <div key={group.sectionKey}>
            <div
              className={`px-3 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500 ${
                groupIdx === 0 ? "mt-1 mb-1" : "mt-4 mb-1"
              }`}
            >
              {t(`sidebar.sections.${group.sectionKey}`)}
            </div>
            {group.items.map((item) =>
              item.to ? (
                <SidebarNavLink
                  key={item.id}
                  kind="link"
                  to={item.to}
                  params={{ projectId }}
                  exact={item.to === "/projects/$projectId"}
                  icon={item.icon}
                  label={t(item.labelKey)}
                  badge={item.badge}
                  badgeLive={item.badgeLive}
                  onNavigate={onClose}
                />
              ) : (
                <SidebarNavLink
                  key={item.id}
                  kind="soon"
                  icon={item.icon}
                  label={t(item.labelKey)}
                  badge={item.badge}
                  badgeLive={item.badgeLive}
                />
              ),
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
