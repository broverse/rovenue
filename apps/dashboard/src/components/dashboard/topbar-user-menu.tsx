import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import { UserCog } from "lucide-react";
import { signOut, useSession } from "../../lib/auth";
import { ThemeToggle } from "../layout/ThemeToggle";

const initialsFromName = (name?: string | null, email?: string | null) => {
  const source = (name && name.trim()) || (email && email.split("@")[0]) || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

export function TopbarUserMenu() {
  const { t } = useTranslation();
  const { data } = useSession();
  const navigate = useNavigate();

  const name = data?.user.name ?? data?.user.email ?? t("common.you");
  const email = data?.user.email ?? name;
  const initials = initialsFromName(data?.user.name, data?.user.email);

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={name}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-rv-warning to-pink-500 text-[11px] font-semibold text-white outline-none ring-rv-divider-strong transition hover:ring-2 focus-visible:ring-2"
      >
        {initials}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} side="bottom" align="end" className="z-50">
          <Menu.Popup className="min-w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            <div className="flex items-center gap-2 px-2 pb-2 pt-1.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-rv-warning to-pink-500 text-[11px] font-semibold text-white">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-rv-mute-800">{name}</div>
                <div className="truncate text-[11px] text-rv-mute-500">{email}</div>
              </div>
            </div>
            <div className="my-1 h-px bg-rv-divider" />
            <div className="flex items-center justify-between rounded px-2 py-1 text-[13px] text-rv-mute-700">
              <span>{t("common.theme")}</span>
              <ThemeToggle />
            </div>
            <div className="my-1 h-px bg-rv-divider" />
            <Menu.Item
              onClick={() => navigate({ to: "/account/profile" })}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
            >
              <UserCog size={13} />
              {t("account.nav.items.profile")}
            </Menu.Item>
            <Menu.Item
              onClick={async () => {
                await signOut();
                await navigate({ to: "/login", search: { error: undefined } });
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
            >
              {t("common.signOut")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
