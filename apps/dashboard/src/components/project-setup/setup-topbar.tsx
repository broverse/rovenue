import { X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import type { SetupMode } from "./types";

type SetupTopbarProps = {
  mode: SetupMode;
  projectName: string | null;
  onModeChange?: (next: SetupMode) => void;
  showModeSwitch?: boolean;
  onCancel?: () => void;
};

/**
 * Minimal sticky top bar — replaces the full sidebar shell while the user is
 * inside the setup wizard. The mode switch is opt-in and only mounts when the
 * caller has both create and update affordances available.
 */
export function SetupTopbar({
  mode,
  projectName,
  onModeChange,
  showModeSwitch,
  onCancel,
}: SetupTopbarProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-rv-divider bg-rv-c1 px-4 sm:gap-4 sm:px-6">
      <Link to="/projects" className="flex shrink-0 items-center gap-2 font-semibold">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-400 to-rv-accent-700 font-rv-mono text-[12px] text-white">
          R
        </span>
        <span className="hidden sm:inline">{t("topNav.appName")}</span>
      </Link>
      <nav className="flex min-w-0 items-center gap-2 text-[13px] text-rv-mute-500">
        <span className="hidden md:inline">{t("projectSetup.crumb.workspace")}</span>
        <span className="hidden text-rv-mute-400 md:inline">/</span>
        <span className="hidden sm:inline">{t("projectSetup.crumb.projects")}</span>
        <span className="hidden text-rv-mute-400 sm:inline">/</span>
        <strong className="truncate font-medium text-foreground">
          {isUpdate && projectName
            ? projectName
            : t("projectSetup.crumb.newProject")}
        </strong>
      </nav>
      <div className="flex-1" />
      {showModeSwitch && onModeChange ? (
        <div className="hidden gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5 sm:inline-flex">
          {(["create", "update"] as const).map((option) => (
            <button
              type="button"
              key={option}
              onClick={() => onModeChange(option)}
              className={cn(
                "h-6 rounded px-3 font-rv-mono text-[12px] capitalize transition",
                mode === option
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t(`projectSetup.mode.${option}`)}
            </button>
          ))}
        </div>
      ) : null}
      {onCancel ? (
        <Button
          type="button"
          variant="light"
          size="sm"
          onClick={onCancel}
          className="text-rv-mute-600 hover:text-foreground"
        >
          {t("projectSetup.cancel")}
        </Button>
      ) : (
        <Link to="/">
          <Button variant="light" size="icon" aria-label={t("projectSetup.close")}>
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </Button>
        </Link>
      )}
    </header>
  );
}
