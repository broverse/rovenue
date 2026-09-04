import { useEffect, useRef, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { CornerUpRight, Languages, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import { RoviMissingConfig } from "../rovi/rovi-missing-config";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import {
  buildMatrixRows,
  isCellMissing,
  localeCompletion,
  machineTranslatedId,
  sourceEntriesFor,
} from "./localization-model";
import { usePaywallTranslate } from "../../lib/hooks/usePaywallTranslate";

type Props = {
  onClose: () => void;
  /** The row to scroll to and highlight on open — the "jump to translation"
   *  affordance from a `LocalizedTextField`'s translate button
   *  (`inspector/fields.tsx`). `null`/absent = no row focused, same as the
   *  top bar's own "Localization" opener. */
  focusKey?: string | null;
};

/** Locale column width in px — wide enough for a short sentence without
 * letting one long string stretch the whole table. */
const LOCALE_COL_WIDTH = 220;
/** Key column width in px. */
const KEY_COL_WIDTH = 200;

/**
 * The focused row's highlight — the same "this is the target" ring the
 * builder already uses for the selected layer row and a legal drag-drop
 * "into" target (`layer-tree.tsx`), reused here rather than inventing a
 * second highlight idiom. Persists for as long as the row stays focused
 * (i.e. the whole time the modal is open for this key), matching how the
 * selected-row ring in the layer tree behaves — not a timed fade, so
 * there's no timer to race in tests or to leave a row highlighted after
 * its window closes.
 */
const FOCUSED_ROW_HIGHLIGHT_CLASS = "ring-2 ring-inset ring-rv-accent-500 bg-rv-accent-500/10";

/**
 * Every localization key the tree uses × every locale it ships in. Blank
 * cells are the point: the builder stubs new keys as "" everywhere, so
 * "present" says nothing — `isCellMissing` uses the same predicate the
 * validator does, so this table and the publish gate agree.
 */
export const LocalizationModal = component(({ onClose, focusKey = null }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);

  const rows = buildMatrixRows(vm.config);
  const focusRowExists = focusKey !== null && rows.some((row) => row.key === focusKey);

  // Scrolls to the focused row once it actually exists in the table —
  // depending on `focusRowExists` rather than just `focusKey` so this
  // fires whether the row was already there on the render `focusKey`
  // arrived on, or only shows up on a later render (e.g. this modal's own
  // config read resolving after the tree finishes loading). Not re-run on
  // every keystroke a co-open edit makes elsewhere in the table, since
  // neither dependency changes while the modal stays open on the same key.
  useEffect(() => {
    if (!focusRowExists) return;
    focusedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusKey, focusRowExists]);

  const translate = usePaywallTranslate();
  // Which locale column is mid-request, so only that column shows a spinner.
  const [translating, setTranslating] = useState<string | null>(null);
  // Keys the last run could not translate, reported by name rather than
  // swallowed: a locale that LOOKS complete but is not is worse than a
  // visible gap.
  const [rejected, setRejected] = useState<{ locale: string; keys: string[] } | null>(null);
  const [confirmingRetranslate, setConfirmingRetranslate] = useState<string | null>(null);
  // The request's failure, by ApiError code (or "HTTP_ERROR" for anything
  // that isn't an ApiError — a network failure, say). `null` = last run
  // (if any) succeeded. Same idiom `start-modal.tsx`'s AI tab uses for its
  // import/generate errors, so a 412 gets the SAME "Rovi needs an API key"
  // affordance rather than a second, differently-worded one.
  const [translateError, setTranslateError] = useState<string | null>(null);

  /**
   * Fills `locale` from the base locale. `keys` is the gap by default; a
   * confirmed retranslate passes every key.
   *
   * `vm.applyTranslations` merges the locale TABLE (other keys survive),
   * and separately protects a key the author hand-edits WHILE this exact
   * request is in flight (`vm.beginTranslateRequest`, called below right
   * before the request fires) — see its doc comment.
   */
  const runTranslate = async (locale: string, keys: readonly string[]) => {
    const paywallId = vm.paywall?.id;
    if (!paywallId || !vm.projectId || keys.length === 0) return;
    const entries = sourceEntriesFor(vm.config, vm.defaultLocale, keys);
    if (Object.keys(entries).length === 0) return;

    vm.beginTranslateRequest(locale, keys);
    setTranslating(locale);
    setRejected(null);
    setTranslateError(null);
    try {
      const result = await translate.mutateAsync({
        projectId: vm.projectId,
        paywallId,
        sourceLocale: vm.defaultLocale,
        targetLocale: locale,
        entries,
      });
      vm.applyTranslations(locale, result.entries);
      if (result.rejected.length > 0) setRejected({ locale, keys: result.rejected });
    } catch (err) {
      // A 429 from `roviQuotaGuard` is the everyday free-tier outcome, not
      // an edge case — it must read as "quota's out", not "button's
      // broken". Caught here (not left to `translate.isError`) so the
      // rejected `mutateAsync` promise never becomes an unhandled
      // rejection.
      setTranslateError(err instanceof ApiError ? err.code : "HTTP_ERROR");
    } finally {
      setTranslating(null);
      setConfirmingRetranslate(null);
    }
  };

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
                        {/* The base locale has nothing to translate FROM,
                            so it gets no control at all. */}
                        {!isBase && (
                          <button
                            type="button"
                            disabled={translating !== null}
                            onClick={() =>
                              complete
                                ? confirmingRetranslate === c.locale
                                  ? void runTranslate(c.locale, rows.map((r) => r.key))
                                  : setConfirmingRetranslate(c.locale)
                                : void runTranslate(c.locale, c.missingKeys)
                            }
                            title={
                              complete
                                ? t(
                                    "paywalls.builder.localization.retranslateHint",
                                    "Every string is filled. Click twice to overwrite them all.",
                                  )
                                : t(
                                    "paywalls.builder.localization.translateHint",
                                    "Fill the {{count}} empty cells from the base locale.",
                                    { count: c.missingKeys.length },
                                  )
                            }
                            className={cn(
                              "mt-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded border px-1.5 text-[10px] transition disabled:cursor-not-allowed disabled:opacity-50",
                              confirmingRetranslate === c.locale
                                ? "border-rv-warning bg-rv-warning/15 text-rv-warning"
                                : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
                            )}
                          >
                            {translating === c.locale ? (
                              <Loader2 size={10} className="animate-spin" />
                            ) : (
                              <Languages size={10} />
                            )}
                            {confirmingRetranslate === c.locale
                              ? t("paywalls.builder.localization.retranslateConfirm", "Overwrite all?")
                              : complete
                                ? t("paywalls.builder.localization.retranslate", "Retranslate")
                                : t("paywalls.builder.localization.translate", "Translate")}
                          </button>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    ref={row.key === focusKey ? focusedRowRef : undefined}
                    data-testid={`loc-row-${row.key}`}
                    className={cn(
                      "border-t border-rv-divider",
                      row.key === focusKey && FOCUSED_ROW_HIGHLIGHT_CLASS,
                    )}
                  >
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
                      const machine = vm.machineTranslated.has(machineTranslatedId(locale, row.key));
                      return (
                        <td key={locale} className="py-2 pr-3 align-top">
                          <div className="flex items-center gap-1">
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
                                : machine
                                  ? "border-rv-violet/50"
                                  : "border-rv-divider",
                            )}
                          />
                          {!isBase && missing && (
                            <button
                              type="button"
                              disabled={translating !== null}
                              onClick={() => void runTranslate(locale, [row.key])}
                              title={t(
                                "paywalls.builder.localization.translateCell",
                                "Translate just this string",
                              )}
                              className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Sparkles size={11} />
                            </button>
                          )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {rejected !== null && (
          <div className="border-t border-rv-divider bg-rv-warning/10 px-5 py-2 text-[12px] text-rv-warning">
            {t("paywalls.builder.localization.rejected", {
              count: rejected.keys.length,
              locale: rejected.locale,
              defaultValue:
                "{{count}} string was left untranslated in {{locale}} — its price placeholders could not be preserved: {{keys}}",
              defaultValue_other:
                "{{count}} strings were left untranslated in {{locale}} — their price placeholders could not be preserved: {{keys}}",
              keys: rejected.keys.join(", "),
            })}
          </div>
        )}

        {translateError === "ROVI_NOT_CONFIGURED" ? (
          <div className="border-t border-rv-divider">
            <RoviMissingConfig projectId={vm.projectId} />
          </div>
        ) : (
          translateError !== null && (
            <div className="border-t border-rv-divider bg-rv-danger/10 px-5 py-2 text-[12px] text-rv-danger">
              {translateError === "ROVI_QUOTA_EXCEEDED"
                ? t(
                    "paywalls.builder.localization.translateQuota",
                    "Rovi's monthly quota is used up — try again next month or raise the limit.",
                  )
                : t("paywalls.builder.localization.translateFailed", "Couldn't translate — try again.")}
            </div>
          )
        )}

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
