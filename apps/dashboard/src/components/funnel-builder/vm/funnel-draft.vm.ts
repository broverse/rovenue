import {
  injectable, inject, state, onMount, derived, trigger,
  type Cleanup, Props,
} from "impair";
import type { NextRule } from "@rovenue/shared/funnel";
import { validateFunnelGraph, type ValidatorIssue } from "@rovenue/shared/funnel";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";
import type { Page, Theme, Settings, TabId } from "../types";
import { toEvalPage } from "../types";

export interface DraftProps {
  projectId: string;
  funnelId: string;
}

const DEFAULT_THEME: Theme = {
  primary: "#3B82F6",
  accent: "#3B82F6",
  bg: "#FFFFFF",
  text: "#0F172A",
  font: "Inter",
  logoUrl: "",
  logoLetter: "F",
};

const DEFAULT_SETTINGS: Settings = {
  iosUrl: "",
  androidUrl: "",
  universalLinkDomain: "",
  deepLinkScheme: "",
  devMode: false,
};

@injectable()
export class FunnelDraftViewModel {
  @state isLoading = true;
  @state error: Error | null = null;
  @state funnel: FunnelDetailDto | null = null;

  @state name = "";
  @state slug = "";
  @state status: "draft" | "published" | "archived" = "draft";
  @state pages: Page[] = [];
  @state theme: Theme = DEFAULT_THEME;
  @state settings: Settings = DEFAULT_SETTINGS;
  @state rules: Record<string, NextRule[]> = {};
  @state defaultNext: Record<string, string | null> = {};

  @state selectedPageId: string | null = null;
  @state activeTab: TabId = "content";
  @state showValidation = false;
  @state showPreview = false;
  @state versionMenuOpen = false;
  @state autosaveStatus: "saved" | "saving" | "error" = "saved";
  @state lastSavedAt: number | null = null;

  constructor(
    @inject(Props) private props: DraftProps,
    @inject(FunnelApi) private api: FunnelApi,
  ) {}

  @onMount
  async load(cleanup: Cleanup) {
    const controller = new AbortController();
    cleanup(() => controller.abort());
    try {
      this.isLoading = true;
      this.error = null;
      const funnel = await this.api.get(this.props.projectId, this.props.funnelId, controller.signal);
      this.applyServer(funnel);
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        this.error = err as Error;
      }
    } finally {
      this.isLoading = false;
    }
  }

  private applyServer(funnel: FunnelDetailDto) {
    this.funnel = funnel;
    this.name = funnel.name;
    this.slug = funnel.slug;
    this.status = funnel.status;
    this.pages = funnel.draftPages as unknown as Page[];
    this.theme = { ...DEFAULT_THEME, ...(funnel.draftTheme as unknown as Partial<Theme>) };
    this.settings = { ...DEFAULT_SETTINGS, ...(funnel.draftSettings as unknown as Partial<Settings>) };
    this.rules = funnel.draftRules ?? {};
    this.defaultNext = funnel.draftDefaultNext ?? {};
    if (!this.selectedPageId && this.pages.length > 0) {
      this.selectedPageId = this.pages[0].id;
    }
    this.lastSavedAt = Date.now();
    this.autosaveStatus = "saved";
  }

  // ----- UI state mutations -----
  selectPage(id: string) { this.selectedPageId = id; }
  goPrev() {
    const i = this.pages.findIndex((p) => p.id === this.selectedPageId);
    if (i > 0) this.selectedPageId = this.pages[i - 1].id;
  }
  goNext() {
    const i = this.pages.findIndex((p) => p.id === this.selectedPageId);
    if (i >= 0 && i < this.pages.length - 1) this.selectedPageId = this.pages[i + 1].id;
  }
  setActiveTab(tab: TabId) { this.activeTab = tab; }
  openValidation() { this.showValidation = true; }
  closeValidation() { this.showValidation = false; }
  openPreview() { this.showPreview = true; }
  closePreview() { this.showPreview = false; }
  toggleVersionMenu() { this.versionMenuOpen = !this.versionMenuOpen; }
  closeVersionMenu() { this.versionMenuOpen = false; }

  // ----- Page list mutations -----
  rename(name: string) { this.name = name; }

  addPage(page: Page, afterId: string | null = null) {
    const idx = afterId
      ? this.pages.findIndex((p) => p.id === afterId) + 1
      : this.pages.length;
    this.pages.splice(idx, 0, page);
    this.selectedPageId = page.id;
  }

  duplicatePage(id: string) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    const copy: Page = JSON.parse(JSON.stringify(this.pages[i]));
    copy.id = `${id}_copy_${Date.now().toString(36)}`;
    this.pages.splice(i + 1, 0, copy);
    this.selectedPageId = copy.id;
  }

  removePage(id: string) {
    const idx = this.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.pages.splice(idx, 1);
    if (this.selectedPageId === id) {
      this.selectedPageId = this.pages[idx]?.id ?? this.pages[idx - 1]?.id ?? null;
    }
    delete this.rules[id];
    delete this.defaultNext[id];
  }

  reorderPages(order: string[]) {
    const byId = new Map(this.pages.map((p) => [p.id, p] as const));
    this.pages = order.map((id) => byId.get(id)).filter((p): p is Page => Boolean(p));
  }

  updatePage(id: string, patch: Partial<Page>) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    Object.assign(this.pages[i], patch);
  }

  addOption(pageId: string) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page) return;
    if (!page.options) page.options = [];
    const i = page.options.length;
    page.options.push({ label: `Option ${i + 1}`, value: `option_${i + 1}` });
  }
  updateOption(pageId: string, idx: number, patch: { label?: string; value?: string }) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options || !page.options[idx]) return;
    Object.assign(page.options[idx], patch);
  }
  removeOption(pageId: string, idx: number) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options) return;
    page.options.splice(idx, 1);
  }

  // ----- Rules -----
  addRule(pageId: string, rule: NextRule) {
    const list = this.rules[pageId] ?? [];
    this.rules[pageId] = [...list, rule];
  }
  updateRule(pageId: string, ruleIdx: number, patch: Partial<NextRule>) {
    const list = this.rules[pageId];
    if (!list || !list[ruleIdx]) return;
    list[ruleIdx] = { ...list[ruleIdx], ...patch };
  }
  removeRule(pageId: string, ruleIdx: number) {
    const list = this.rules[pageId];
    if (!list) return;
    list.splice(ruleIdx, 1);
    if (list.length === 0) delete this.rules[pageId];
  }
  setDefaultNext(pageId: string, target: string | null) {
    if (target === null) delete this.defaultNext[pageId];
    else this.defaultNext[pageId] = target;
  }

  // ----- Theme / settings -----
  updateTheme(patch: Partial<Theme>) { Object.assign(this.theme, patch); }
  updateSettings(patch: Partial<Settings>) { Object.assign(this.settings, patch); }

  // ----- Derived -----
  @derived
  get selectedIdx(): number {
    return this.pages.findIndex((p) => p.id === this.selectedPageId);
  }

  @derived
  get selectedPage(): Page | null {
    return this.selectedPageId
      ? this.pages.find((p) => p.id === this.selectedPageId) ?? null
      : this.pages[0] ?? null;
  }

  @derived
  get validation(): {
    errors: ValidatorIssue[];
    warnings: ValidatorIssue[];
    byPage: Map<string, ValidatorIssue[]>;
    unreachable: Set<string>;
  } {
    const minimal = this.pages.map((p) =>
      toEvalPage(p, this.rules[p.id] ?? [], this.defaultNext[p.id] ?? undefined),
    );
    const result = validateFunnelGraph(minimal as never);
    const errors = result.ok ? [] : result.issues;
    const warnings = result.warnings;
    const byPage = new Map<string, ValidatorIssue[]>();
    const unreachable = new Set<string>();
    for (const i of [...errors, ...warnings]) {
      const pageId = "pageId" in i ? i.pageId : undefined;
      if (pageId) {
        const arr = byPage.get(pageId) ?? [];
        arr.push(i);
        byPage.set(pageId, arr);
      }
      if (i.code === "UNREACHABLE" && pageId) unreachable.add(pageId);
    }
    return { errors, warnings, byPage, unreachable };
  }

  @derived get errorCount() { return this.validation.errors.length; }
  @derived get warnCount() { return this.validation.warnings.length; }

  @derived get isDirty() {
    return this.autosaveStatus === "saving" || this.autosaveStatus === "error";
  }

  // ----- Autosave + publish/duplicate/discard -----
  @trigger.debounce(800)
  async autosave(cleanup: Cleanup) {
    if (!this.funnel || this.isLoading) return;
    // Touch every reactive field we want to send so the trigger re-runs when
    // any of them changes. impair's @trigger tracks reads inside the body.
    const payload = {
      name: this.name,
      slug: this.slug,
      draftPages: this.pages as never,
      draftTheme: this.theme as never,
      draftSettings: this.settings as never,
      draftRules: this.rules,
      draftDefaultNext: this.defaultNext,
    };
    const controller = new AbortController();
    cleanup(() => controller.abort());
    try {
      this.autosaveStatus = "saving";
      const next = await this.api.patchDraft(
        this.props.projectId,
        this.props.funnelId,
        payload,
        controller.signal,
      );
      this.funnel = next;
      this.lastSavedAt = Date.now();
      this.autosaveStatus = "saved";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      this.autosaveStatus = "error";
    }
  }

  async publish() {
    if (this.errorCount > 0) {
      this.showValidation = true;
      return;
    }
    const result = await this.api.publish(this.props.projectId, this.props.funnelId);
    this.applyServer(result.funnel);
  }

  async duplicate() {
    return this.api.duplicate(this.props.projectId, this.props.funnelId);
  }

  async discardDraft() {
    const funnel = await this.api.get(this.props.projectId, this.props.funnelId);
    this.applyServer(funnel);
  }
}

