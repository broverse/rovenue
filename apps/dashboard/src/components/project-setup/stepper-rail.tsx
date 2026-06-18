import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { STEPS } from "./mock-data";
import type { SetupMode } from "./types";

type StepperRailProps = {
  mode: SetupMode;
  step: number;
  isStepDone: (id: number) => boolean;
  onJump: (id: number) => void;
};

/**
 * Sticky left rail with progress bar, numbered steps, and a help footer.
 * In create mode steps lock until the previous one is valid; in update mode
 * everything is freely jumpable.
 */
export function StepperRail({
  mode,
  step,
  isStepDone,
  onJump,
}: StepperRailProps) {
  const { t } = useTranslation();
  const isUpdate = mode === "update";
  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  return (
    <>
      <div className="sticky top-14 z-[5] flex items-center gap-3 border-b border-rv-divider bg-rv-c1 px-4 py-3 md:hidden">
        <span className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
          {t("projectSetup.footer.stepMeta", {
            step,
            total: STEPS.length,
            label: "",
          }).replace(/\s*·\s*$/, "")}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-rv-c3">
          <div
            className="h-full rounded-full bg-rv-accent-500 transition-[width] duration-200 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="truncate text-[12px] font-medium text-foreground">
          {t(
            `projectSetup.steps.${
              STEPS.find((entry) => entry.id === step)?.key ?? "basics"
            }.label`,
          )}
        </span>
      </div>
      <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[280px] shrink-0 overflow-y-auto border-r border-rv-divider bg-rv-c1 px-6 py-7 md:block">
      <h2 className="mb-1 text-[18px] font-semibold text-foreground">
        {t(
          isUpdate
            ? "projectSetup.rail.titleUpdate"
            : "projectSetup.rail.titleCreate",
        )}
      </h2>
      <p className="mb-6 text-[12px] leading-relaxed text-rv-mute-500">
        {t(
          isUpdate
            ? "projectSetup.rail.subtitleUpdate"
            : "projectSetup.rail.subtitleCreate",
        )}
      </p>

      <div className="mb-6 h-1 overflow-hidden rounded-full bg-rv-c3">
        <div
          className="h-full rounded-full bg-rv-accent-500 transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="flex flex-col gap-0.5">
        {STEPS.map((entry, index) => {
          const isActive = step === entry.id;
          const isDone =
            entry.id < step || (isUpdate && isStepDone(entry.id) && !isActive);
          const allPreviousDone = STEPS.slice(0, index).every((prev) =>
            isStepDone(prev.id),
          );
          const isLocked = !isUpdate && entry.id > step && !allPreviousDone;
          const showLine = index < STEPS.length - 1;

          return (
            <li key={entry.id} className="relative">
              <button
                type="button"
                disabled={isLocked}
                onClick={() => !isLocked && onJump(entry.id)}
                className={cn(
                  "grid w-full grid-cols-[28px_1fr] items-start gap-3 rounded-md px-2 py-2.5 text-left transition",
                  isActive && "bg-rv-c2",
                  !isActive && !isLocked && "hover:bg-rv-c2",
                  isLocked && "cursor-not-allowed opacity-45",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border font-rv-mono text-[11px] font-medium",
                    isActive
                      ? "border-rv-accent-500 bg-rv-accent-500 text-white"
                      : isDone
                        ? "border-rv-success bg-rv-success text-white"
                        : "border-rv-divider bg-rv-c3 text-rv-mute-600",
                  )}
                >
                  {isDone && !isActive ? (
                    <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />
                  ) : (
                    entry.id
                  )}
                </span>
                <span>
                  <span
                    className={cn(
                      "block text-[13px] font-medium",
                      isActive ? "text-foreground" : "text-rv-mute-700",
                    )}
                  >
                    {t(`projectSetup.steps.${entry.key}.label`)}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-rv-mute-500">
                    {t(`projectSetup.steps.${entry.key}.desc`)}
                  </span>
                </span>
              </button>
              {showLine ? (
                <span
                  aria-hidden="true"
                  className="absolute left-[21px] top-[38px] h-[calc(100%-32px)] w-px bg-rv-divider"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 rounded-md border border-rv-divider bg-rv-c2 p-3 text-[11px] leading-relaxed text-rv-mute-600">
        <span className="font-semibold text-rv-mute-700">
          {t("projectSetup.rail.tipLabel")}
        </span>{" "}
        {t("projectSetup.rail.tipBody")}
      </div>
    </aside>
    </>
  );
}
