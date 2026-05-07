import { Pencil, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";

const SWATCHES = [
  "#3B82F6",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#F43F5E",
  "#52525B",
] as const;

type AvatarEditorProps = {
  initials: string;
  color: string;
  onColorChange: (next: string) => void;
};

export function AvatarEditor({ initials, color, onColorChange }: AvatarEditorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative flex size-[76px] shrink-0 items-center justify-center rounded-full font-rv-mono text-[28px] font-semibold text-white"
        style={{ background: color }}
      >
        {initials}
        <span className="absolute bottom-0 right-0 inline-flex size-[22px] cursor-pointer items-center justify-center rounded-full border-2 border-rv-c1 bg-rv-c4 text-rv-mute-700">
          <Pencil size={11} />
        </span>
      </div>
      <div className="flex-1">
        <div className="mb-2 flex gap-2">
          <Button variant="flat" size="sm">
            <Upload size={13} />
            {t("account.profile.photo.upload")}
          </Button>
          <Button variant="light" size="sm">
            {t("account.profile.photo.remove")}
          </Button>
        </div>
        <div className="flex gap-1">
          {SWATCHES.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={c}
              onClick={() => onColorChange(c)}
              className={cn(
                "size-[18px] rounded-[4px] border-2 transition",
                color === c ? "border-foreground" : "border-transparent",
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-rv-mute-500">
          {t("account.profile.photo.hint")}
        </p>
      </div>
    </div>
  );
}
