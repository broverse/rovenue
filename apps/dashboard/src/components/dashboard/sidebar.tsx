import { useTranslation } from "react-i18next";
import { BookOpen, Search } from "lucide-react";
import { useSession } from "../../lib/auth";
import { AppSwitcher } from "./app-switcher";
import { SidebarNavLink } from "./sidebar-nav-link";
import { SidebarUserMenu } from "./sidebar-user-menu";
import { NAV_SECTIONS } from "./navigation";

type SidebarProps = {
  projectId: string;
  projectName: string;
  envLabel?: string;
};

const initialsFromName = (name?: string | null, email?: string | null) => {
  const source = (name && name.trim()) || (email && email.split("@")[0]) || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

/**
 * Persistent left navigation. Sticky to the viewport, scrollable middle
 * section, fixed footer with search trigger / docs / user menu.
 */
export function Sidebar({ projectId, projectName, envLabel }: SidebarProps) {
  const { t } = useTranslation();
  const { data } = useSession();
  const userName = data?.user.name ?? data?.user.email ?? t("common.you");
  const initials = initialsFromName(data?.user.name, data?.user.email);

  return (
    <aside className="sticky top-0 flex h-screen flex-col overflow-hidden border-r border-rv-divider bg-rv-c1">
      <AppSwitcher projectId={projectId} projectName={projectName} envLabel={envLabel} />

      <nav
        className="flex-1 overflow-y-auto px-2 pb-2 pt-3 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]"
        aria-label={t("sidebar.primaryAria")}
      >
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

      <div className="flex flex-col gap-0.5 border-t border-rv-divider p-2">
        <button
          type="button"
          className="mb-1.5 flex h-8 cursor-pointer items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-xs text-rv-mute-500 transition hover:border-rv-c4 hover:text-rv-mute-700"
        >
          <Search size={14} />
          <span>{t("sidebar.search")}</span>
          <span className="ml-auto inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
            ⌘K
          </span>
        </button>
        <a
          href="https://docs.rovenue.dev"
          target="_blank"
          rel="noreferrer"
          className="flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-3 text-[13px] text-rv-mute-600 transition hover:bg-rv-c2 hover:text-rv-mute-800"
        >
          <BookOpen size={14} />
          <span>{t("sidebar.footer.docs")}</span>
        </a>
        <a
          href="https://github.com/broverse/rovenue"
          target="_blank"
          rel="noreferrer"
          className="flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-3 text-[13px] text-rv-mute-600 transition hover:bg-rv-c2 hover:text-rv-mute-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
          </svg>
          <span>{t("sidebar.footer.github")}</span>
          <span className="ml-auto rounded-full bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-600">
            {t("sidebar.footer.selfHost")}
          </span>
        </a>
        <div className="my-1.5 h-px bg-rv-divider" />
        <SidebarUserMenu initials={initials} name={userName} role={t("common.owner")} />
      </div>
    </aside>
  );
}
