import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { CornerUpRight, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { buildMatrixRows, isCellMissing, localeCompletion } from "./localization-model";

type Props = { onClose: () => void };

/** Locale column width in px — wide enough for a short sentence without
 * letting one long string stretch the whole table. */
const LOCALE_COL_WIDTH = 220;
/** Key column width in px. */
const KEY_COL_WIDTH = 200;

/**
 * Every localization key the tree uses × every locale it ships in. Blank
 * cells are the point: the builder stubs new keys as "" everywhere, so
 * "present" says nothing — `isCellMissing` uses the same predicate the
 * validator does, so this table and the publish gate agree.
 */
export const LocalizationModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();

  const rows = buildMatrixRows(vm.config);
  const completions = vm.locales.map((l) => localeCompletion(vm.config, rows, l));
  const baseGaps = completions.find((c) => c.locale === vm.defaultLocale)?.missingKeys.length ?? 0;
  const otherGaps = completions
    .filter((c) => c.locale !== vm.defaultLocale)
    .reduce((n, c) => n + c.missingKeys.length, 0);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[min(1000px,96vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("paywalls.builder.localization.title", "Localization")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.localization.subtitle",
                "Every string the paywall uses, in every locale it ships in. Blank cells are untranslated.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.localization.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-rv-mute-500">
              {t(
                "paywalls.builder.localization.empty",
                "This paywall has no text yet. Add a text or button node to translate.",
              )}
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <th
                    style={{ width: KEY_COL_WIDTH }}
                    className="sticky top-0 z-10 bg-rv-c1 pb-2 pr-3 align-bottom font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500"
                  >
                    {t("paywalls.builder.localization.stringCol", "String")}
                  </th>
                  {completions.map((c) => {
                    const isBase = c.locale === vm.defaultLocale;
                    const complete = c.done === c.total;
                    return (
                      <th
                        key={c.locale}
                        style={{ width: LOCALE_COL_WIDTH }}
                        className="sticky top-0 z-10 bg-rv-c1 pb-2 pr-3 align-bottom"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-rv-mono text-[11px] uppercase text-foreground">
                            {c.locale}
                          </span>
                          {isBase && (
                            <span className="rounded bg-rv-accent-500/15 px-1 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-accent-500">
                              {t("paywalls.builder.localization.base", "base")}
                            </span>
                          )}
                        </div>
                        <div
                          className={cn(
                            "mt-0.5 font-rv-mono text-[10px]",
                            complete
                              ? "text-rv-success"
                              : isBase
                                ? "text-rv-danger"
                                : "text-rv-warning",
                          )}
                        >
                          {c.done}/{c.total}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t border-rv-divider">
                    <td className="py-2 pr-3 align-top">
                      <div className="font-rv-mono text-[11px] text-foreground">{row.key}</div>
                      <div className="mt-0.5 flex items-center gap-1 font-rv-mono text-[10px] text-rv-mute-500">
                        <span>
                          {row.nodeType} · {row.nodeId}
                        </span>
                        {row.viaOverride && (
                          <span
                            title={t(
                              "paywalls.builder.localization.viaOverrideHint",
                              "This key is introduced by a conditional override, so it only renders when that condition holds.",
                            )}
                            className="rounded bg-rv-violet/15 px-1 text-rv-violet"
                          >
                            {t("paywalls.builder.localization.viaOverride", "override")}
                          </span>
                        )}
                        {row.otherNodeIds.length > 0 && (
                          <span
                            title={t(
                              "paywalls.builder.localization.alsoUsedBy",
                              "Also used by: {{ids}}",
                              { ids: row.otherNodeIds.join(", ") },
                            )}
                            className="rounded bg-rv-c3 px-1 text-rv-mute-600"
                          >
                            +{row.otherNodeIds.length}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            vm.selectNode(row.nodeId);
                            onClose();
                          }}
                          title={t(
                            "paywalls.builder.localization.jump",
                            "Select the node using this string",
                          )}
                          className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
                        >
                          <CornerUpRight size={11} />
                        </button>
                      </div>
                    </td>
                    {vm.locales.map((locale) => {
                      const missing = isCellMissing(vm.config, row.key, locale);
                      const isBase = locale === vm.defaultLocale;
                      return (
                        <td key={locale} className="py-2 pr-3 align-top">
                          <input
                            value={vm.config.localizations[locale]?.[row.key] ?? ""}
                            onChange={(e) =>
                              vm.setLocaleText(row.key, locale, e.currentTarget.value)
                            }
                            placeholder={t(
                              "paywalls.builder.localization.untranslated",
                              "untranslated",
                            )}
                            className={cn(
                              "h-7 w-full rounded border bg-rv-c2 px-2 text-[12px] text-foreground outline-none transition focus:border-rv-accent-500",
                              missing
                                ? isBase
                                  ? "border-rv-danger/50"
                                  : "border-rv-warning/50"
                                : "border-rv-divider",
                            )}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-rv-divider px-5 py-3">
          <div className="flex-1 text-[12px]">
            {baseGaps > 0 ? (
              <span className="text-rv-danger">
                {t("paywalls.builder.localization.blocking", {
                  count: baseGaps,
                  defaultValue: "{{count}} blank string in the base locale blocks publishing.",
                  defaultValue_other: "{{count}} blank strings in the base locale block publishing.",
                })}
              </span>
            ) : otherGaps > 0 ? (
              <span className="text-rv-warning">
                {t("paywalls.builder.localization.warnings", {
                  count: otherGaps,
                  defaultValue: "{{count}} untranslated string — it falls back to the base locale.",
                  defaultValue_other:
                    "{{count}} untranslated strings — they fall back to the base locale.",
                })}
              </span>
            ) : (
              <span className="text-rv-success">
                {t("paywalls.builder.localization.complete", "Every string is translated.")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
          >
            {t("paywalls.builder.localization.done", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
});
