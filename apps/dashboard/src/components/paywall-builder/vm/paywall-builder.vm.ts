import {
  injectable, inject, state, onMount, onInit, derived, trigger,
  type Cleanup, Props,
} from "impair";
import { createId } from "@paralleldrive/cuid2";
import type { BuilderConfig, BuilderIssue, PaywallNode } from "@rovenue/shared/paywall";
import { emptyBuilderConfig, validateBuilderConfig } from "@rovenue/shared/paywall";
import {
  PaywallBuilderApi,
  type PaywallBuilderDetailDto,
} from "../../../lib/services/paywall-builder-api";
import * as treeOps from "../tree-ops";
import { PRESETS } from "../presets";
import type { CanvasDevice, ColorScheme } from "../types";

export interface PaywallBuilderProps {
  projectId: string;
  paywallId: string;
}

@injectable()
export class PaywallBuilderViewModel {
  @state isLoading = true;
  @state error: Error | null = null;
  @state paywall: PaywallBuilderDetailDto | null = null;

  @state config: BuilderConfig = emptyBuilderConfig();
  @state selectedNodeId: string | null = null;

  @state editLocale = "en";
  @state defaultLocale = "en";
  @state locales: string[] = ["en"];

  @state colorScheme: ColorScheme = "light";

  setColorScheme(scheme: ColorScheme) {
    this.colorScheme = scheme;
  }

  toggleColorScheme() {
    this.colorScheme = this.colorScheme === "light" ? "dark" : "light";
  }

  // Canvas preview UI state — mirrors FunnelDraftViewModel's canvas
  // mechanics verbatim (same ZOOM_STEPS/WHEEL_THRESHOLD/wheel handler)
  // so the Task-6 UI can reuse the same CanvasEditor wiring.
  @state canvasDevice: CanvasDevice = "phone";
  @state canvasZoom = 1;
  private canvasWheelAcc = 0;
  private static readonly ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  private static readonly WHEEL_THRESHOLD = 120;

  setCanvasDevice(d: CanvasDevice) {
    this.canvasDevice = d;
  }
  setCanvasZoom(z: number) {
    this.canvasZoom = Math.max(0.25, Math.min(3, z));
  }
  zoomStep(dir: 1 | -1) {
    const steps = PaywallBuilderViewModel.ZOOM_STEPS;
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
    const T = PaywallBuilderViewModel.WHEEL_THRESHOLD;
    while (Math.abs(this.canvasWheelAcc) >= T) {
      this.zoomStep(this.canvasWheelAcc > 0 ? -1 : 1);
      this.canvasWheelAcc -= Math.sign(this.canvasWheelAcc) * T;
    }
  }

  @state autosaveStatus: "saved" | "saving" | "error" = "saved";
  @state lastSavedAt: number | null = null;
  // JSON snapshot of the most recently saved `config`. Compared against
  // the current snapshot to drive `isDirty` — the only thing autosave
  // ever PATCHes is `{ builderConfig: config }`.
  @state lastSavedSnapshot: string = "";

  @state projectId = "";
  @state paywallId = "";

  constructor(
    @inject(Props) private props: PaywallBuilderProps,
    @inject(PaywallBuilderApi) private api: PaywallBuilderApi,
  ) {}

  @onInit
  init() {
    this.projectId = this.props.projectId;
    this.paywallId = this.props.paywallId;
  }

  private disposed = false;
  private saveController: AbortController | null = null;

  @onMount
  guardUnload(cleanup: Cleanup) {
    const handler = (e: BeforeUnloadEvent) => {
      if (!this.isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    cleanup(() => window.removeEventListener("beforeunload", handler));
  }

  @onMount
  async load(cleanup: Cleanup) {
    cleanup(() => {
      this.disposed = true;
    });
    try {
      this.isLoading = true;
      this.error = null;
      const detail = await this.api.get(this.props.projectId, this.props.paywallId);
      if (this.disposed) return;
      this.applyServer(detail);
    } catch (err) {
      if (this.disposed) return;
      // eslint-disable-next-line no-console
      console.error("[PaywallBuilderViewModel] load failed", err);
      this.error = err as Error;
    } finally {
      if (!this.disposed) {
        this.isLoading = false;
      }
    }
  }

  /** Syncs `paywall`/`config`/locale state from a server DTO. Does NOT touch save bookkeeping. */
  private syncFromDetail(detail: PaywallBuilderDetailDto) {
    this.paywall = detail;
    this.config = detail.builderConfig ?? emptyBuilderConfig(detail.defaultLocale);
    this.defaultLocale = this.config.defaultLocale;
    this.locales = Object.keys(this.config.localizations);
    if (!this.locales.includes(this.editLocale)) this.editLocale = this.defaultLocale;
  }

  private applyServer(detail: PaywallBuilderDetailDto) {
    this.syncFromDetail(detail);
    this.selectedNodeId = null;
    this.lastSavedAt = Date.now();
    this.autosaveStatus = "saved";
    this.lastSavedSnapshot = this.snapshot();
  }

  /** Stringified picture of everything that gets shipped on autosave (only `config`). */
  private snapshot(): string {
    return JSON.stringify(this.config);
  }

  // ----- Node CRUD (delegates to tree-ops) -----
  selectNode(id: string | null) {
    this.selectedNodeId = id;
  }

  addNode(type: PaywallNode["type"], parentId: string, index?: number): string {
    const node = treeOps.newNode(type, () => createId().slice(0, 8));
    this.config = { ...this.config, root: treeOps.insertNode(this.config.root, parentId, node, index) };
    this.registerFreshLocKeys(node);
    this.selectedNodeId = node.id;
    return node.id;
  }

  /** Registers an empty string for a freshly-created node's loc key(s) in every locale. */
  private registerFreshLocKeys(node: PaywallNode) {
    const keys: string[] = [];
    if (node.type === "text") keys.push(node.key);
    if (node.type === "button" || node.type === "purchaseButton") keys.push(node.labelKey);
    if (keys.length === 0) return;

    const localizations: Record<string, Record<string, string>> = { ...this.config.localizations };
    for (const locale of this.locales) {
      const table = { ...(localizations[locale] ?? {}) };
      for (const key of keys) {
        if (!(key in table)) table[key] = "";
      }
      localizations[locale] = table;
    }
    this.config = { ...this.config, localizations };
  }

  removeNode(id: string) {
    this.config = { ...this.config, root: treeOps.removeNode(this.config.root, id) };
    if (this.selectedNodeId === id) this.selectedNodeId = null;
  }

  moveNode(id: string, dir: 1 | -1) {
    this.config = { ...this.config, root: treeOps.moveNode(this.config.root, id, dir) };
  }

  updateNode<T extends PaywallNode>(id: string, patch: Partial<T>) {
    this.config = { ...this.config, root: treeOps.updateNode<T>(this.config.root, id, patch) };
  }

  @derived
  get selectedNode(): PaywallNode | null {
    return this.selectedNodeId ? treeOps.findNode(this.config.root, this.selectedNodeId) : null;
  }

  // ----- Localization text -----
  setLocaleText(key: string, locale: string, value: string) {
    if (!this.locales.includes(locale)) return;
    const localizations = {
      ...this.config.localizations,
      [locale]: { ...(this.config.localizations[locale] ?? {}), [key]: value },
    };
    this.config = { ...this.config, localizations };
  }

  // ----- Locale ops (mirror the paywalls remote-config-utils semantics) -----
  setEditLocale(locale: string) {
    if (!this.locales.includes(locale)) return;
    this.editLocale = locale;
  }

  addLocale(rawCode: string) {
    const code = rawCode.trim().toLowerCase();
    if (!code || code in this.config.localizations) return;
    const localizations = { ...this.config.localizations, [code]: {} };
    this.config = { ...this.config, localizations };
    this.locales = Object.keys(localizations);
    this.editLocale = code;
  }

  /**
   * Removes a locale. No-op when it's the last remaining locale or the
   * code is unknown. If the removed locale was the default, the default
   * reassigns to whichever locale key sorts first among the survivors.
   */
  removeLocale(code: string) {
    const keys = Object.keys(this.config.localizations);
    if (keys.length <= 1 || !keys.includes(code)) return;

    const localizations = { ...this.config.localizations };
    delete localizations[code];
    const defaultLocale =
      this.config.defaultLocale === code ? Object.keys(localizations).sort()[0]! : this.config.defaultLocale;

    this.config = { ...this.config, localizations, defaultLocale };
    this.locales = Object.keys(localizations);
    this.defaultLocale = defaultLocale;
    if (this.editLocale === code) this.editLocale = defaultLocale;
  }

  setDefaultLocale(code: string) {
    if (!(code in this.config.localizations)) return;
    this.config = { ...this.config, defaultLocale: code };
    this.defaultLocale = code;
  }

  // ----- Presets -----
  applyPreset(id: "hero" | "comparison") {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const config = preset.build(this.defaultLocale || "en");
    this.config = config;
    this.locales = Object.keys(config.localizations);
    this.defaultLocale = config.defaultLocale;
    if (!this.locales.includes(this.editLocale)) this.editLocale = this.defaultLocale;
    this.selectedNodeId = null;
  }

  // ----- Derived -----
  @derived
  get validationIssues(): BuilderIssue[] {
    return validateBuilderConfig(this.config, {
      offeringPackageIds: this.paywall?.offeringPackageIds ?? [],
    });
  }

  @derived get errorIssues() {
    return this.validationIssues.filter((i) => i.code !== "LOCALE_KEY_GAP");
  }
  @derived get warningIssues() {
    return this.validationIssues.filter((i) => i.code === "LOCALE_KEY_GAP");
  }

  @derived get isDirty() {
    return this.snapshot() !== this.lastSavedSnapshot;
  }

  // ----- Autosave + manual save -----
  // Reset a sticky "error" status the moment the user edits anything
  // again — see FunnelDraftViewModel.clearAutosaveError for rationale.
  @trigger
  clearAutosaveError() {
    void this.config;
    if (this.autosaveStatus === "error") this.autosaveStatus = "saving";
  }

  @trigger.throttle(30000)
  async autosave(cleanup: Cleanup) {
    if (!this.paywall || this.isLoading) return;
    void this.config; // tracked read — throttle re-runs on every config mutation
    const snap = this.snapshot();
    if (snap === this.lastSavedSnapshot) return;

    this.saveController?.abort();
    const controller = new AbortController();
    this.saveController = controller;
    cleanup(() => controller.abort());
    try {
      this.autosaveStatus = "saving";
      const detail = await this.api.patchBuilderConfig(
        this.props.projectId,
        this.props.paywallId,
        this.config,
        this.paywall.offeringId,
        this.paywall.offeringPackageIds,
        controller.signal,
      );
      if (this.saveController !== controller) return;
      this.syncFromDetail(detail);
      this.lastSavedAt = Date.now();
      this.lastSavedSnapshot = snap;
      this.autosaveStatus = "saved";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (this.saveController !== controller) return;
      this.autosaveStatus = "error";
    } finally {
      if (this.saveController === controller) this.saveController = null;
    }
  }

  /** Force-flush the current config to the backend, bypassing the autosave throttle. */
  async saveNow() {
    if (!this.paywall || this.isLoading) return;
    if (!this.isDirty) {
      this.autosaveStatus = "saved";
      return;
    }
    this.saveController?.abort();
    const controller = new AbortController();
    this.saveController = controller;
    this.autosaveStatus = "saving";
    const snap = this.snapshot();
    try {
      const detail = await this.api.patchBuilderConfig(
        this.props.projectId,
        this.props.paywallId,
        this.config,
        this.paywall.offeringId,
        this.paywall.offeringPackageIds,
        controller.signal,
      );
      if (this.saveController !== controller) return;
      this.syncFromDetail(detail);
      this.lastSavedAt = Date.now();
      this.lastSavedSnapshot = snap;
      this.autosaveStatus = "saved";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (this.saveController !== controller) return;
      this.autosaveStatus = "error";
    } finally {
      if (this.saveController === controller) this.saveController = null;
    }
  }

  async discardDraft() {
    const detail = await this.api.get(this.props.projectId, this.props.paywallId);
    this.applyServer(detail);
  }
}
