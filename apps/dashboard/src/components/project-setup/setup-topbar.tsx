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
}: SetupTopbarProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-rv-divider bg-rv-c1 px-6">
      <Link to="/projects" className="flex items-center gap-2 font-semibold">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-400 to-rv-accent-700 font-rv-mono text-[12px] text-white">
          R
        </span>
        <span>{t("topNav.appName")}</span>
      </Link>
      <nav className="flex items-center gap-2 text-[13px] text-rv-mute-500">
        <span>{t("projectSetup.crumb.workspace")}</span>
        <span className="text-rv-mute-400">/</span>
        <span>{t("projectSetup.crumb.projects")}</span>
        <span className="text-rv-mute-400">/</span>
        <strong className="font-medium text-foreground">
          {isUpdate && projectName
            ? projectName
            : t("projectSetup.crumb.newProject")}
        </strong>
      </nav>
      <div className="flex-1" />
      {showModeSwitch && onModeChange ? (
        <div className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
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
      <Link to="/projects">
        <Button variant="light" size="icon" aria-label={t("projectSetup.close")}>
          <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
        </Button>
      </Link>
    </header>
  );
}
