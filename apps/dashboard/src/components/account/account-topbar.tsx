import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useSession } from "../../lib/auth";

const initialsFromName = (name?: string | null, email?: string | null) => {
  const source = (name && name.trim()) || (email && email.split("@")[0]) || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

type AccountTopbarProps = {
  current: string;
};

export function AccountTopbar({ current }: AccountTopbarProps) {
  const { t } = useTranslation();
  const { data } = useSession();
  const userName = data?.user.name ?? t("common.you");
  const email = data?.user.email ?? "";
  const initials = initialsFromName(data?.user.name, data?.user.email);

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-rv-divider bg-rv-c1 px-3 sm:gap-4 sm:px-6">
      <Link to="/projects" className="flex shrink-0 items-center gap-2 font-semibold">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-400 to-rv-accent-700 font-rv-mono text-[12px] text-white">
          R
        </span>
        <span className="hidden sm:inline">{t("topNav.appName")}</span>
      </Link>

      <div className="flex min-w-0 items-center gap-2 text-[13px] text-rv-mute-500">
        <span className="hidden sm:inline">{t("account.topbar.breadcrumb")}</span>
        <span className="hidden text-rv-mute-400 sm:inline">/</span>
        <span className="truncate font-medium text-foreground">{current}</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-rv-accent-500 font-rv-mono text-[11px] font-semibold text-white">
          {initials}
        </div>
        <div className="hidden text-[12px] sm:block">
          <div className="font-medium leading-tight">{userName}</div>
          {email ? (
            <div className="font-rv-mono text-[10px] leading-tight text-rv-mute-500">
              {email}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
