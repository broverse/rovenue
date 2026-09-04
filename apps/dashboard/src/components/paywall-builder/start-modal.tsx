import { useMemo, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { FilePlus2, Search, Sparkles, Store, X } from "lucide-react";
import type { BuilderConfig, PaywallNode } from "@rovenue/shared/paywall";
import { cn } from "../../lib/cn";
import { ApiError, rpc, unwrap } from "../../lib/api";
import { RoviMissingConfig } from "../rovi/rovi-missing-config";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { TEMPLATES, TEMPLATE_CATEGORIES, type TemplateId } from "./templates";
import { filterTemplates } from "./start-model";
import { TemplatePreview, TEMPLATE_PREVIEW_WIDTH } from "./template-preview";

type Props = { onClose: () => void };

type StartTab = "presets" | "appstore" | "ai";

/** Canned prompts for the AI tab — clicking one fills the textarea. */
const SUGGESTION_CHIPS = [
  "3-tier subscription paywall with a free trial",
  "Minimal single-plan paywall with a feature list",
  "Paywall with social proof and a limited-time countdown",
  "Onboarding-style paywall with a 3-step timeline",
] as const;

/** Recursive node count for the import/generate preview cards. */
function countNodes(node: PaywallNode): number {
  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * Card preview geometry. The card renders the template's REAL tree through
 * `PaywallRenderer` at `CARD_PREVIEW_SCALE`, then clips it to
 * `THUMB_HEIGHT` — the top of a paywall (art, headline, the first plan
 * rows) is what tells two templates apart, and showing all 780pt scaled to
 * fit would make every card an illegible smudge.
 */
const CARD_PREVIEW_SCALE = 0.44;
const CARD_PREVIEW_RENDER_WIDTH = TEMPLATE_PREVIEW_WIDTH * CARD_PREVIEW_SCALE;
/** Card thumbnail height in px. */
const THUMB_HEIGHT = 208;

/**
 * Starting points for a paywall. Applying a preset REPLACES the whole
 * config, so on a non-empty tree a card arms a confirm first — on an
 * empty tree there is nothing to lose and it applies straight away.
 */
export const StartModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [confirmingId, setConfirmingId] = useState<TemplateId | null>(null);
  const [tab, setTab] = useState<StartTab>("presets");

  // Gallery filters. `null` category means "All" — the catalogue is
  // eighteen entries, which is past the point where one flat grid is
  // browsable.
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Shared apply-with-confirm for the two config-producing tabs: same
  // two-click data-loss semantics as the preset cards (applying REPLACES
  // the whole config, dropping every non-default locale).
  const [confirmingApply, setConfirmingApply] = useState(false);

  // From App Store state.
  const [storeUrl, setStoreUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{
    config: BuilderConfig;
    metadata: { name: string; iconUrl: string };
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // AI assist state.
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<BuilderConfig | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const treeIsEmpty = vm.config.root.children.length === 0;
  // Applying a preset replaces `config` wholesale, and a preset's
  // `localizations` only carries its default locale — so every OTHER
  // locale (and every translated string in it) is silently dropped.
  const otherLocalesLost = vm.locales.filter((l) => l !== vm.defaultLocale).length;

  // Building eighteen configs is pure work — do it once per locale rather
  // than on every keystroke in the search box.
  const configs = useMemo(() => {
    const locale = vm.defaultLocale || "en";
    return new Map(TEMPLATES.map((t) => [t.id, t.build(locale)] as const));
  }, [vm.defaultLocale]);

  const visibleTemplates = useMemo(
    () => filterTemplates(TEMPLATES, { category, query }),
    [category, query],
  );

  const choose = (id: TemplateId) => {
    if (!treeIsEmpty && confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    vm.applyTemplate(id);
    onClose();
  };

  /** The new tabs' apply: first click arms on a non-empty tree, second applies. */
  const applyConfig = (config: BuilderConfig) => {
    if (!treeIsEmpty && !confirmingApply) {
      setConfirmingApply(true);
      return;
    }
    vm.applyExternalConfig(config);
    onClose();
  };

  const switchTab = (next: StartTab) => {
    setTab(next);
    setConfirmingId(null);
    setConfirmingApply(false);
  };

  const handleImport = async () => {
    setImporting(true);
    setImportError(null);
    setImported(null);
    setConfirmingApply(false);
    try {
      const result = await unwrap<{
        config: BuilderConfig;
        metadata: { name: string; iconUrl: string };
      }>(
        rpc.dashboard.projects[":projectId"].paywalls["from-app-store"].$post({
          param: { projectId: vm.projectId },
          json: { url: storeUrl },
        }),
      );
      setImported(result);
    } catch (err) {
      setImportError(err instanceof ApiError ? err.code : "HTTP_ERROR");
    } finally {
      setImporting(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    setGenerated(null);
    setConfirmingApply(false);
    try {
      const result = await unwrap<{ config: BuilderConfig }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"]["paywall-generate"].$post({
          param: { projectId: vm.projectId, id: vm.paywallId },
          json: { prompt },
        }),
      );
      setGenerated(result.config);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.code : "HTTP_ERROR");
    } finally {
      setGenerating(false);
    }
  };

  const importErrorText =
    importError === "APP_NOT_FOUND"
      ? t("paywalls.builder.start.appStoreNotFound", "No app found for that App Store link.")
      : importError === "APP_STORE_LOOKUP_FAILED"
        ? t("paywalls.builder.start.appStoreLookupFailed", "App Store lookup failed — try again.")
        : importError === "VALIDATION_ERROR"
          ? t("paywalls.builder.start.appStoreBadUrl", "That doesn't look like an App Store listing URL.")
          : importError
            ? t("paywalls.builder.start.importFailed", "Import failed — try again.")
            : null;

  const confirmCopy =
    otherLocalesLost > 0
      ? t("paywalls.builder.start.confirmReplaceLocalized", {
          count: otherLocalesLost,
          defaultValue:
            "Click again to replace your current design — this also deletes {{count}} other locale and all its translations.",
          defaultValue_other:
            "Click again to replace your current design — this also deletes {{count}} other locales and all their translations.",
        })
      : t("paywalls.builder.start.confirmReplace", "Click again to replace your current design.");

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(880px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("paywalls.builder.start.title", "Start a paywall")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.start.subtitle",
                "Begin from a layout and edit everything after — or start from a blank canvas.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.start.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-rv-divider px-5 pt-2">
          {(
            [
              { id: "presets" as const, label: t("paywalls.builder.start.tabPresets", "Presets"), icon: FilePlus2 },
              { id: "appstore" as const, label: t("paywalls.builder.start.tabAppStore", "From App Store"), icon: Store },
              { id: "ai" as const, label: t("paywalls.builder.start.tabAi", "AI assist"), icon: Sparkles },
            ]
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => switchTab(id)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-[12px] font-medium transition",
                tab === id
                  ? "border-rv-accent-500 text-foreground"
                  : "border-transparent text-rv-mute-500 hover:text-foreground",
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {tab === "appstore" && (
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <p className="text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.start.appStoreHint",
                "Paste an App Store listing link — the icon, name, description and screenshots become a draft you can edit.",
              )}
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="url"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.currentTarget.value)}
                placeholder="https://apps.apple.com/us/app/…/id123456789"
                className="h-8 flex-1 rounded-md border border-rv-divider bg-rv-c2 px-2.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500/60"
              />
              <button
                type="button"
                disabled={importing || storeUrl.trim().length === 0}
                onClick={handleImport}
                className="h-8 cursor-pointer rounded-md bg-rv-accent-500 px-3 text-[12px] font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {importing
                  ? t("paywalls.builder.start.importing", "Importing…")
                  : t("paywalls.builder.start.importAction", "Import")}
              </button>
            </div>
            {importErrorText && (
              <p className="mt-2 text-[12px] text-rv-danger">{importErrorText}</p>
            )}
            {imported && (
              <div className="mt-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c2 p-3">
                <img src={imported.metadata.iconUrl} alt="" className="h-12 w-12 rounded-xl" />
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-foreground">{imported.metadata.name}</div>
                  <div className="text-[11px] text-rv-mute-500">
                    {t("paywalls.builder.start.importNodeCount", "{{count}} nodes in the draft", {
                      count: countNodes(imported.config.root),
                    })}
                  </div>
                  {confirmingApply && (
                    <div className="mt-1 text-[11px] text-rv-warning">{confirmCopy}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => applyConfig(imported.config)}
                  className={cn(
                    "h-8 cursor-pointer rounded-md px-3 text-[12px] font-medium transition",
                    confirmingApply
                      ? "bg-rv-warning text-black"
                      : "bg-rv-accent-500 text-white",
                  )}
                >
                  {t("paywalls.builder.start.applyAction", "Apply")}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "ai" &&
          (generateError === "ROVI_NOT_CONFIGURED" ? (
            <div className="flex min-h-[220px] flex-1">
              <RoviMissingConfig projectId={vm.projectId} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
              <p className="text-[12px] text-rv-mute-500">
                {t(
                  "paywalls.builder.start.aiHint",
                  "Describe the paywall you want — a draft is generated for you to edit.",
                )}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {SUGGESTION_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    data-chip
                    onClick={() => setPrompt(chip)}
                    className="cursor-pointer rounded-full border border-rv-divider bg-rv-c2 px-2.5 py-1 text-[11px] text-rv-mute-500 transition hover:border-rv-accent-500/50 hover:text-foreground"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                rows={3}
                placeholder={t(
                  "paywalls.builder.start.aiPlaceholder",
                  "e.g. A warm, minimal paywall with a yearly-first plan picker and a 7-day trial CTA",
                )}
                className="mt-3 w-full resize-none rounded-md border border-rv-divider bg-rv-c2 p-2.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500/60"
              />
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  disabled={generating || prompt.trim().length === 0}
                  onClick={handleGenerate}
                  className="h-8 cursor-pointer rounded-md bg-rv-accent-500 px-3 text-[12px] font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating
                    ? t("paywalls.builder.start.generating", "Generating…")
                    : t("paywalls.builder.start.generateAction", "Generate")}
                </button>
                {generateError && generateError !== "ROVI_NOT_CONFIGURED" && (
                  <span className="text-[12px] text-rv-danger">
                    {generateError === "ROVI_QUOTA_EXCEEDED"
                      ? t(
                          "paywalls.builder.start.generateQuota",
                          "Rovi's monthly quota is used up — try again next month or raise the limit.",
                        )
                      : t("paywalls.builder.start.generateFailed", "Couldn't generate a paywall — try rephrasing.")}
                  </span>
                )}
              </div>
              {generated && (
                <div className="mt-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c2 p-3">
                  <div className="flex-1">
                    <div className="text-[13px] font-medium text-foreground">
                      {t("paywalls.builder.start.generatedTitle", "Draft ready")}
                    </div>
                    <div className="text-[11px] text-rv-mute-500">
                      {t("paywalls.builder.start.importNodeCount", "{{count}} nodes in the draft", {
                        count: countNodes(generated.root),
                      })}
                    </div>
                    {confirmingApply && (
                      <div className="mt-1 text-[11px] text-rv-warning">{confirmCopy}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => applyConfig(generated)}
                    className={cn(
                      "h-8 cursor-pointer rounded-md px-3 text-[12px] font-medium transition",
                      confirmingApply ? "bg-rv-warning text-black" : "bg-rv-accent-500 text-white",
                    )}
                  >
                    {t("paywalls.builder.start.applyAction", "Apply")}
                  </button>
                </div>
              )}
            </div>
          ))}

        {tab === "presets" && (
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {/* Category chips + search. Both narrow the same grid; "All" is a
              chip rather than a cleared state so there is always exactly one
              selected chip to read. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {[{ id: null, label: t("paywalls.builder.start.categoryAll", "All") }, ...TEMPLATE_CATEGORIES.map((c) => ({ id: c.id as string | null, label: t(`paywalls.builder.start.categories.${c.id}`, c.label) }))].map(
              (chip) => (
                <button
                  key={chip.id ?? "all"}
                  type="button"
                  onClick={() => setCategory(chip.id)}
                  aria-pressed={category === chip.id}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition",
                    category === chip.id
                      ? "border-rv-accent-500 bg-rv-accent-500/15 text-foreground"
                      : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3",
                  )}
                >
                  {chip.label}
                </button>
              ),
            )}
            <div className="relative ml-auto">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-rv-mute-500"
                aria-hidden
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("paywalls.builder.start.searchPlaceholder", "Search templates")}
                aria-label={t("paywalls.builder.start.searchLabel", "Search templates")}
                className="h-7 w-48 rounded-md border border-rv-divider bg-rv-c2 pl-7 pr-2 text-[12px] text-foreground placeholder:text-rv-mute-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
              />
            </div>
          </div>

          {visibleTemplates.length === 0 && (
            <div className="rounded-lg border border-rv-divider bg-rv-c2 px-4 py-6 text-center text-[12px] text-rv-mute-500">
              {t("paywalls.builder.start.noMatches", "No templates match that search.")}
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            {visibleTemplates.map((preset) => {
              const confirming = confirmingId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => choose(preset.id)}
                  className={cn(
                    "cursor-pointer rounded-lg border p-2.5 text-left transition",
                    confirming
                      ? "border-rv-warning bg-rv-warning/10"
                      : "border-rv-divider bg-rv-c2 hover:border-rv-accent-500/50 hover:bg-rv-c3",
                  )}
                >
                  <div
                    className="mx-auto overflow-hidden rounded-md bg-rv-c3"
                    style={{ height: THUMB_HEIGHT, width: CARD_PREVIEW_RENDER_WIDTH }}
                  >
                    <TemplatePreview
                      config={configs.get(preset.id)!}
                      scale={CARD_PREVIEW_SCALE}
                      colorScheme={vm.colorScheme}
                      locale={vm.defaultLocale || "en"}
                    />
                  </div>
                  <div className="mt-2.5">
                    <span className="rounded bg-rv-accent-500/15 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-accent-500">
                      {t(`paywalls.builder.start.presets.${preset.id}.tag`, preset.tag)}
                    </span>
                    <div className="mt-1.5 text-[13px] font-medium text-foreground">
                      {t(`paywalls.builder.start.presets.${preset.id}.name`, preset.name)}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                      {confirming
                        ? otherLocalesLost > 0
                          ? t("paywalls.builder.start.confirmReplaceLocalized", {
                              count: otherLocalesLost,
                              defaultValue:
                                "Click again to replace your current design — this also deletes {{count}} other locale and all its translations.",
                              defaultValue_other:
                                "Click again to replace your current design — this also deletes {{count}} other locales and all their translations.",
                            })
                          : t(
                              "paywalls.builder.start.confirmReplace",
                              "Click again to replace your current design.",
                            )
                        : t(
                            `paywalls.builder.start.presets.${preset.id}.description`,
                            preset.description,
                          )}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Blank canvas is deliberately last — it changes nothing, so it never confirms. */}
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-rv-divider bg-rv-c2 p-2.5 text-left transition hover:border-rv-accent-500/50 hover:bg-rv-c3"
            >
              <div
                className="mx-auto flex flex-col items-center justify-center gap-1.5 rounded-md bg-rv-c3 text-rv-mute-500"
                style={{ height: THUMB_HEIGHT, width: CARD_PREVIEW_RENDER_WIDTH }}
              >
                <FilePlus2 size={20} />
                <span className="text-[11px]">
                  {t("paywalls.builder.start.blankThumb", "Empty")}
                </span>
              </div>
              <div className="mt-2.5">
                <span className="rounded bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-600">
                  {t("paywalls.builder.start.blankTag", "Start empty")}
                </span>
                <div className="mt-1.5 text-[13px] font-medium text-foreground">
                  {t("paywalls.builder.start.blankName", "Blank canvas")}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                  {t("paywalls.builder.start.blankDescription", "Build from scratch.")}
                </div>
              </div>
            </button>
          </div>
        </div>
        )}

        <div className="flex items-center border-t border-rv-divider px-5 py-3">
          <div className="flex-1 text-[11px] text-rv-mute-500">
            {t("paywalls.builder.start.footerHint", "Everything is editable after you pick one.")}
          </div>
        </div>
      </div>
    </div>
  );
});
