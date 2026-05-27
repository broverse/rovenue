import {
  injectable, inject, state, onMount, onInit, derived, trigger,
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

  // Canvas preview UI state lives on the VM so a) impair tracks change
  // for the `component()`-wrapped CanvasEditor and b) the wheel handler
  // (attached via callback ref) has a stable target to mutate without
  // depending on React's useEffect, which impair's component wrapper
  // doesn't reliably invoke for inner-rendered hooks.
  @state canvasDevice: "phone" | "tablet" | "desktop" = "phone";
  @state canvasZoom = 1;
  // Non-reactive accumulator for trackpad wheel events.
  private canvasWheelAcc = 0;
  private static readonly ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  private static readonly WHEEL_THRESHOLD = 120;

  setCanvasDevice(d: "phone" | "tablet" | "desktop") {
    this.canvasDevice = d;
  }
  setCanvasZoom(z: number) {
    this.canvasZoom = Math.max(0.25, Math.min(3, z));
  }
  zoomStep(dir: 1 | -1) {
    const steps = FunnelDraftViewModel.ZOOM_STEPS;
    let i = steps.findIndex((s) => s >= this.canvasZoom);
    if (i < 0) i = steps.length - 1;
    const next = steps[Math.max(0, Math.min(steps.length - 1, i + dir))];
    this.setCanvasZoom(next);
  }
  resetCanvasZoom() {
    this.setCanvasZoom(1);
  }
  /**
   * Process a native wheel event on the canvas surface. Returns whether
   * the gesture should be treated as a zoom (caller should preventDefault).
   * Pinch gestures arrive as wheel events with ctrlKey=true and tiny
   * deltaY (~1-5) — amplify so one pinch lands a step.
   */
  handleCanvasWheel(deltaY: number, isPinch: boolean) {
    const delta = isPinch ? deltaY * 8 : deltaY;
    this.canvasWheelAcc += delta;
    const T = FunnelDraftViewModel.WHEEL_THRESHOLD;
    while (Math.abs(this.canvasWheelAcc) >= T) {
      this.zoomStep(this.canvasWheelAcc > 0 ? -1 : 1);
      this.canvasWheelAcc -= Math.sign(this.canvasWheelAcc) * T;
    }
  }

  // Mirrors of Props.projectId / Props.funnelId so React-side consumers
  // (e.g. the paywall product picker that runs a TanStack Query) can read
  // them without violating the private `props` field on this VM.
  @state projectId = "";
  @state funnelId = "";

  constructor(
    @inject(Props) private props: DraftProps,
    @inject(FunnelApi) private api: FunnelApi,
  ) {}

  @onInit
  init() {
    this.projectId = this.props.projectId;
    this.funnelId = this.props.funnelId;
  }

  // Track whether this VM instance has been disposed so a late-arriving
  // fetch response doesn't mutate it. We can't rely on AbortController +
  // @onMount in React StrictMode — the double-mount cycle disposes the
  // first instance while its fetch is still in flight, and impair's
  // catch hooks fire differently than expected.
  private disposed = false;

  @onMount
  async load(cleanup: Cleanup) {
    cleanup(() => {
      this.disposed = true;
    });
    try {
      this.isLoading = true;
      this.error = null;
      const funnel = await this.api.get(this.props.projectId, this.props.funnelId);
      if (this.disposed) return;
      this.applyServer(funnel);
    } catch (err) {
      if (this.disposed) return;
      // eslint-disable-next-line no-console
      console.error("[FunnelDraftViewModel] load failed", err);
      this.error = err as Error;
    } finally {
      if (!this.disposed) {
        this.isLoading = false;
      }
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
  reorderOption(pageId: string, from: number, to: number) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options) return;
    if (from < 0 || from >= page.options.length) return;
    if (to < 0 || to >= page.options.length) return;
    const [moved] = page.options.splice(from, 1);
    page.options.splice(to, 0, moved);
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
  // Throttled so the backend gets at most one PATCH per 30s no matter how
  // fast the user types. impair's throttle fires the leading change
  // immediately and coalesces subsequent edits into a trailing call when
  // the window expires — so a single keystroke saves right away but
  // sustained editing doesn't hammer the server.
  @trigger.throttle(30000)
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

