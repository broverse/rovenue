import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccountTopbar } from "./account-topbar";
import { AccountNav, AccountNavMobile } from "./account-nav";
import { ACCOUNT_TABS, type AccountTabId } from "./account-nav-config";

type AccountShellProps = {
  active: AccountTabId;
  children: ReactNode;
};

export function AccountShell({ active, children }: AccountShellProps) {
  const { t } = useTranslation();
  const current = ACCOUNT_TABS.find((tab) => tab.id === active);
  const currentLabel = current ? t(current.labelKey) : "";

  return (
    <div className="dark min-h-screen bg-rv-bg font-[Geist,ui-sans-serif,system-ui,sans-serif] text-foreground antialiased">
      <AccountTopbar current={currentLabel} />
      <AccountNavMobile active={active} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <AccountNav active={active} />
        <main className="mx-auto w-full max-w-[920px] px-12 pb-20 pt-9 max-[1080px]:px-7 max-[1080px]:pb-15">
          {children}
        </main>
      </div>
    </div>
  );
}

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
};

export function AccountPageHeader({ title, description }: PageHeaderProps) {
  return (
    <div className="mb-7">
      <h1 className="m-0 text-[22px] font-semibold leading-7">{title}</h1>
      {description ? (
        <p className="mt-1 text-[13px] text-rv-mute-500">{description}</p>
      ) : null}
    </div>
  );
}
