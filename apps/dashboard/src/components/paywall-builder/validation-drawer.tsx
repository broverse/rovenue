import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { TriangleAlert, X } from "lucide-react";
import type { BuilderIssue } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = {
  onClose: () => void;
};

export const ValidationDrawer = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const errors = vm.errorIssues;
  const warnings = vm.warningIssues;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px]" />
      <div className="fixed right-0 top-0 z-[61] flex h-screen w-full max-w-[440px] flex-col border-l border-rv-divider-strong bg-rv-c1 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
        <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
          <div>
            <h2 className="m-0 text-[16px] font-semibold tracking-tight">
              {t("paywalls.builder.validation.title", "Paywall issues")}
            </h2>
            <p className="mt-1 m-0 text-[12px] text-rv-mute-500">
              {t("paywalls.builder.validation.subtitle", "{{errors}} issue(s) · {{warnings}} warning(s)", {
                errors: errors.length,
                warnings: warnings.length,
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("paywalls.builder.validation.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {errors.length > 0 && (
            <>
              <SectionLabel>{t("paywalls.builder.validation.errors", "Errors")}</SectionLabel>
              {errors.map((iss, i) => (
                <IssueRow key={`err-${i}`} issue={iss} kind="error" />
              ))}
            </>
          )}
          {warnings.length > 0 && (
            <>
              <SectionLabel className="mt-5">
                {t("paywalls.builder.validation.warnings", "Warnings")}
              </SectionLabel>
              {warnings.map((iss, i) => (
                <IssueRow key={`warn-${i}`} issue={iss} kind="warning" />
              ))}
            </>
          )}
          {errors.length === 0 && warnings.length === 0 && (
            <div className="text-[12px] text-rv-mute-500">
              {t("paywalls.builder.validation.none", "No issues — this paywall is ready.")}
            </div>
          )}
        </div>
      </div>
    </>
  );
});

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-1.5 mt-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500", className)}>
      {children}
    </div>
  );
}

function issueTitle(issue: BuilderIssue, t: (key: string, fallback: string) => string): string {
  switch (issue.code) {
    case "DUPLICATE_NODE_ID":
      return t("paywalls.builder.validation.codeDuplicateId", "Duplicate node id");
    case "UNKNOWN_LOC_KEY":
      return t("paywalls.builder.validation.codeUnknownKey", "Missing default-locale text");
    case "FOREIGN_PACKAGE_ID":
      return t("paywalls.builder.validation.codeForeignPackage", "Unknown package reference");
    case "MISSING_PURCHASE_BUTTON":
      return t("paywalls.builder.validation.codeMissingPurchase", "Missing purchase button");
    case "LOCALE_KEY_GAP":
      return t("paywalls.builder.validation.codeLocaleGap", "Missing translation");
    default:
      return issue.code;
  }
}

function IssueRow({ issue, kind }: { issue: BuilderIssue; kind: "error" | "warning" }) {
  const { t } = useTranslation();
  const isError = kind === "error";
  return (
    <div className={cn("mb-2.5 rounded-md border bg-rv-c2 p-3", isError ? "border-rv-danger/30" : "border-rv-warning/30")}>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded",
            isError ? "bg-rv-danger/15 text-rv-danger" : "bg-rv-warning/15 text-rv-warning",
          )}
        >
          <TriangleAlert size={12} />
        </div>
        <div className="text-[13px] font-semibold text-foreground">{issueTitle(issue, t)}</div>
        {issue.nodeId && (
          <div className="ml-auto font-rv-mono text-[10px] text-rv-mute-500">{issue.nodeId}</div>
        )}
      </div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-rv-mute-700">{issue.message}</div>
      {issue.locale && (
        <div className="mt-1 font-rv-mono text-[10px] text-rv-mute-500">
          {t("paywalls.builder.validation.locale", "Locale")}: {issue.locale}
        </div>
      )}
    </div>
  );
}
