import { useTranslation } from "react-i18next";
import { BookOpen, Menu as MenuIcon, Search } from "lucide-react";
import { BellDropdown } from "../notifications/bell-dropdown";
import { TopbarRoviButton } from "../rovi/topbar-rovi-button";
import { TopbarUserMenu } from "./topbar-user-menu";

const IS_SELF_HOSTED = import.meta.env.VITE_SELF_HOSTED === "true";

type TopbarProps = {
  projectName: string;
  current: string;
  /** Mobile-only: opens the sidebar drawer. */
  onMenuClick?: () => void;
};

/**
 * Sticky page topbar — breadcrumb on the left, search + docs / github /
 * notifications / user on the right.
 */
export function Topbar({ projectName, current, onMenuClick }: TopbarProps) {
  const { t } = useTranslation();

  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-rv-divider bg-rv-bg/80 px-3 backdrop-blur-sm sm:px-4 lg:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground lg:hidden"
      >
        <MenuIcon size={18} />
      </button>

      <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-rv-mute-600">
        <span className="hidden truncate sm:inline">{projectName}</span>
        <span className="hidden text-rv-mute-400 sm:inline">/</span>
        <span className="truncate font-medium text-foreground">{current}</span>
      </div>

      <button
        type="button"
        className="ml-3 hidden h-8 min-w-[180px] cursor-pointer items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-xs text-rv-mute-500 transition hover:border-rv-c4 hover:text-rv-mute-700 md:inline-flex lg:min-w-[240px]"
        aria-label={t("topbar.search")}
      >
        <Search size={14} />
        <span>{t("topbar.search")}</span>
        <span className="ml-auto inline-flex h-[18px] items-center rounded border border-rv-divider bg-rv-c4 px-1.5 font-rv-mono text-[10px] text-rv-mute-600">
          ⌘K
        </span>
      </button>

      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        <a
          href="https://docs.rovenue.io"
          target="_blank"
          rel="noreferrer"
          aria-label={t("topbar.docs")}
          title={t("topbar.docs")}
          className="hidden size-8 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground sm:inline-flex"
        >
          <BookOpen size={16} />
        </a>
        {IS_SELF_HOSTED && (
          <a
            href="https://github.com/broverse/rovenue"
            target="_blank"
            rel="noreferrer"
            aria-label={t("topbar.github")}
            title={t("topbar.github")}
            className="hidden size-8 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground sm:inline-flex"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
          </a>
        )}

        <span className="mx-0.5 hidden h-5 w-px bg-rv-divider sm:inline-block" aria-hidden="true" />

        <BellDropdown />

        <span className="mx-0.5 hidden h-5 w-px bg-rv-divider sm:inline-block" aria-hidden="true" />
        <TopbarRoviButton />
        <span className="mx-0.5 hidden h-5 w-px bg-rv-divider sm:inline-block" aria-hidden="true" />
        <TopbarUserMenu />
      </div>
    </div>
  );
}
