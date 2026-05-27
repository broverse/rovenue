import { injectable, inject, state, onMount, type Cleanup, Props } from "impair";
import type { NextRule } from "@rovenue/shared/funnel";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";
import type { Page, Theme, Settings, TabId } from "../types";

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
}
