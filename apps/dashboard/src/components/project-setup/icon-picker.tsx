import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { ICON_COLORS } from "./mock-data";
import { initials } from "./format";

type IconPickerProps = {
  iconText: string;
  name: string;
  color: string;
  onColorChange: (next: string) => void;
};

/**
 * Big square avatar that previews initials over a chosen background plus a
 * row of color swatches. The active swatch gets a thicker outline.
 */
export function IconPicker({
  iconText,
  name,
  color,
  onColorChange,
}: IconPickerProps) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0">
      <span className="mb-1.5 block text-[12px] font-medium text-rv-mute-700">
        {t("projectSetup.basics.icon")}
      </span>
      <div
        style={{ background: color }}
        className="flex size-16 items-center justify-center rounded-xl font-rv-mono text-2xl font-semibold text-white"
        aria-hidden="true"
      >
        {iconText || initials(name) || "?"}
      </div>
      <div className="mt-1.5 flex gap-1">
        {ICON_COLORS.map((swatch) => (
          <button
            type="button"
            key={swatch}
            onClick={() => onColorChange(swatch)}
            aria-label={t("projectSetup.basics.colorOption", { color: swatch })}
            className={cn(
              "size-3.5 rounded-sm border-2 transition",
              color === swatch ? "border-foreground" : "border-transparent",
            )}
            style={{ background: swatch }}
          />
        ))}
      </div>
    </div>
  );
}
