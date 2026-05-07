import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";

type ReviewSectionProps = {
  index: number;
  title: ReactNode;
  onEdit: () => void;
  children: ReactNode;
};

export function ReviewSection({
  index,
  title,
  onEdit,
  children,
}: ReviewSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-3.5 rounded-md border border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3">
        <h4 className="text-[13px] font-semibold text-foreground">
          {index} · {title}
        </h4>
        <button
          type="button"
          onClick={onEdit}
          className="text-[12px] text-rv-accent-400 transition hover:underline"
        >
          {t("projectSetup.review.edit")}
        </button>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

type ReviewRowProps = {
  label: ReactNode;
  value: ReactNode;
  empty?: boolean;
};

export function ReviewRow({ label, value, empty }: ReviewRowProps) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-3 border-b border-white/5 py-2 text-[12px] last:border-b-0">
      <div className="text-rv-mute-500">{label}</div>
      <div
        className={cn(
          empty
            ? "italic text-rv-mute-500"
            : "font-rv-mono text-rv-mute-700",
        )}
      >
        {value}
      </div>
    </div>
  );
}
