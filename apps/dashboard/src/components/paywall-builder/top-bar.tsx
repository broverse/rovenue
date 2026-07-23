import { useState } from "react";
import { component, useService } from "impair";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  BadgeCheck,
  BadgeX,
  ChevronDown,
  CloudUpload,
  GitBranch,
  Languages,
  Moon,
  Plus,
  Sun,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { VersionMenu } from "./version-menu";
import { buildMatrixRows, localeCompletion } from "./localization-model";

type Props = {
  projectId: string;
  onOpenValidation: () => void;
  onOpenDiff: () => void;
  onOpenLocalization: () => void;
};

export const TopBar = component(({ projectId, onOpenValidation, onOpenDiff, onOpenLocalization }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [versionsOpen, setVersionsOpen] = useState(false);

  const locRows = buildMatrixRows(vm.config);
  const baseGapCount = localeCompletion(vm.config, locRows, vm.defaultLocale).missingKeys.length;
  const otherGapCount = vm.locales
    .filter((l) => l !== vm.defaultLocale)
    .reduce((n, l) => n + localeCompletion(vm.config, locRows, l).missingKeys.length, 0);

  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-rv-divider bg-rv-c1 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to="/projects/$projectId/paywalls"
          params={{ projectId }}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          title={t("paywalls.builder.topbar.close", "Close builder")}
        >
          <X size={16} />
        </Link>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-foreground">
            {vm.paywall?.name ?? t("paywalls.builder.topbar.loading", "Paywall builder")}
          </div>
          <div className="truncate font-rv-mono text-[10px] text-rv-mute-500">{vm.paywall?.identifier}</div>
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        <AutosaveBadge />
        {vm.publishState === "error" && (
          <button
            type="button"
            onClick={onOpenValidation}
            title={vm.publishError ?? ""}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger"
          >
            <TriangleAlert size={12} />
            {t("paywalls.builder.topbar.publishFailed", "Publish failed")}
          </button>
        )}
        <LocaleSwitcher />
        <button
          type="button"
          onClick={onOpenLocalization}
          title={t("paywalls.builder.topbar.localization", "Localization matrix")}
          className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <Table2 size={13} />
          {(baseGapCount > 0 || otherGapCount > 0) && (
            <span
              className={cn(
                "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
                baseGapCount > 0 ? "bg-rv-danger" : "bg-rv-warning",
              )}
            />
          )}
        </button>

        <button
          type="button"
          onClick={() => vm.toggleColorScheme()}
          title={t("paywalls.builder.topbar.colorScheme", "Toggle light/dark preview")}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
        >
          {vm.colorScheme === "light" ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        <button
          type="button"
          onClick={() => vm.togglePreviewEligible()}
          title={t(
            "paywalls.builder.topbar.previewEligibleHint",
            "Preview as intro-offer eligible / ineligible",
          )}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.previewEligible
              ? "border-rv-success/40 bg-rv-success/10 text-rv-success hover:bg-rv-success/20"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {vm.previewEligible ? <BadgeCheck size={13} /> : <BadgeX size={13} />}
          {vm.previewEligible
            ? t("paywalls.builder.topbar.previewEligible", "Eligible")
            : t("paywalls.builder.topbar.previewIneligible", "Ineligible")}
        </button>

        {vm.errorIssues.length > 0 ? (
          <button
            type="button"
            onClick={onOpenValidation}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger transition hover:bg-rv-danger/20"
          >
            <TriangleAlert size={12} />
            {t("paywalls.builder.topbar.issues", { count: vm.errorIssues.length })}
          </button>
        ) : vm.warningIssues.length > 0 ? (
          <button
            type="button"
            onClick={onOpenValidation}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-warning/40 bg-rv-warning/15 px-2 text-[11px] font-medium text-rv-warning transition hover:bg-rv-warning/20"
          >
            <TriangleAlert size={12} />
            {t("paywalls.builder.topbar.warnings", { count: vm.warningIssues.length })}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenValidation}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-success/30 bg-rv-success/10 px-2 text-[11px] font-medium text-rv-success transition hover:bg-rv-success/20"
          >
            {t("paywalls.builder.topbar.noIssues", "No issues")}
          </button>
        )}

        <div className="mx-0.5 h-5 w-px bg-rv-divider" />

        {vm.status === "published" && !vm.hasUnpublishedChanges && (
          <span
            title={t(
              "paywalls.builder.topbar.inSyncHint",
              "The draft matches what devices are being served",
            )}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
          >
            {t("paywalls.builder.topbar.inSync", "in sync")}
          </span>
        )}

        <div className="relative flex items-center">
          <button
            type="button"
            disabled={!vm.canPublish}
            onClick={() => void vm.publish()}
            title={
              vm.canPublish
                ? t("paywalls.builder.topbar.publishHint", "Publish over-the-air")
                : t(
                    "paywalls.builder.topbar.publishBlocked",
                    "Resolve blocking issues before publishing",
                  )
            }
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-l-md border border-r-0 px-2.5 text-[11px] font-medium transition",
              vm.canPublish
                ? "cursor-pointer border-rv-accent-500 bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                : "cursor-not-allowed border-rv-divider bg-rv-c2 text-rv-mute-600 opacity-60",
            )}
          >
            <CloudUpload size={13} />
            {vm.publishState === "publishing"
              ? t("paywalls.builder.topbar.publishing", "Publishing…")
              : t("paywalls.builder.topbar.publish", "Publish")}
          </button>
          <button
            type="button"
            onClick={() => setVersionsOpen((o) => !o)}
            title={t("paywalls.builder.topbar.versions", "Version history")}
            className="flex h-7 w-6 cursor-pointer items-center justify-center rounded-r-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            <GitBranch size={12} />
          </button>
          {versionsOpen && (
            <VersionMenu onClose={() => setVersionsOpen(false)} onOpenDiff={onOpenDiff} />
          )}
        </div>
      </div>
    </header>
  );
});

const AutosaveBadge = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const saving = vm.autosaveStatus === "saving";
  const err = vm.autosaveStatus === "error";
  return (
    <span
      title={
        err
          ? t("paywalls.builder.topbar.autosaveErrorHint", "Save failed — retrying")
          : t("paywalls.builder.topbar.autosaveHint", "Autosaved on every change")
      }
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          saving ? "animate-pulse bg-rv-warning" : err ? "bg-rv-danger" : "bg-rv-success",
        )}
      />
      {saving
        ? t("paywalls.builder.topbar.autosaveSaving", "saving")
        : err
          ? t("paywalls.builder.topbar.autosaveError", "retrying")
          : t("paywalls.builder.topbar.autosaveSaved", "saved")}
    </span>
  );
});

const LocaleSwitcher = component(() => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [newLocale, setNewLocale] = useState("");

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] uppercase text-foreground transition hover:bg-rv-c3"
      >
        <Languages size={13} className="text-rv-mute-500" />
        {vm.editLocale}
        <ChevronDown size={12} className="text-rv-mute-500" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[49]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-[240px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
            <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
              {t("paywalls.builder.locales.title", "Locales")}
            </div>
            {vm.locales.map((code) => (
              <div
                key={code}
                className={cn(
                  "flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[12px]",
                  code === vm.editLocale ? "bg-rv-c2" : "hover:bg-rv-c2",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    vm.setEditLocale(code);
                    setOpen(false);
                  }}
                  className="flex flex-1 cursor-pointer items-center gap-2 text-left text-foreground"
                >
                  <span className="font-rv-mono text-[11px] uppercase">{code}</span>
                  {code === vm.defaultLocale && (
                    <span className="font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                      {t("paywalls.builder.locales.default", "default")}
                    </span>
                  )}
                </button>
                {vm.locales.length > 1 && code !== vm.defaultLocale && (
                  <button
                    type="button"
                    title={t("paywalls.builder.locales.remove", "Remove {{locale}}", { locale: code })}
                    onClick={() => vm.removeLocale(code)}
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
            <form
              className="mt-1.5 flex items-center gap-1 border-t border-rv-divider pt-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newLocale.trim()) return;
                vm.addLocale(newLocale);
                setNewLocale("");
              }}
            >
              <input
                value={newLocale}
                onChange={(e) => setNewLocale(e.currentTarget.value)}
                placeholder={t("paywalls.builder.locales.addPlaceholder", "e.g. tr")}
                className="h-7 min-w-0 flex-1 rounded border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
              />
              <button
                type="submit"
                title={t("paywalls.builder.locales.add", "Add locale")}
                className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
              >
                <Plus size={12} />
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
});
