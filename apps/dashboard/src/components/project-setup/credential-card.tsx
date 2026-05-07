import type { ReactNode } from "react";
import { PlatformIcon } from "./platform-icon";

type CredentialCardProps = {
  iconBg: string;
  iconLabel: string;
  title: ReactNode;
  children: ReactNode;
};

export function CredentialCard({
  iconBg,
  iconLabel,
  title,
  children,
}: CredentialCardProps) {
  return (
    <div className="mt-3.5 rounded-md border border-rv-divider bg-rv-c1 p-4">
      <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-foreground">
        <PlatformIcon bg={iconBg} label={iconLabel} size="sm" />
        {title}
      </h4>
      {children}
    </div>
  );
}
