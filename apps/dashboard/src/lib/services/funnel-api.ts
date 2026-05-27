import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { PagesArray, Theme as FunnelTheme, NextRule } from "@rovenue/shared/funnel";

export interface FunnelSettingsDto {
  iosUrl?: string;
  androidUrl?: string;
  universalLinkDomain?: string;
  deepLinkScheme?: string;
  devMode?: boolean;
  [key: string]: unknown;
}

export interface FunnelDetailDto {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  currentVersionNo: number | null;
  draftPages: PagesArray;
  draftTheme: FunnelTheme;
  draftSettings: FunnelSettingsDto;
  draftRules: Record<string, NextRule[]>;
  draftDefaultNext: Record<string, string | null>;
  draftDiffersFromPublished: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface PatchDraftPayload {
  name?: string;
  slug?: string;
  draftPages?: PagesArray;
  draftTheme?: FunnelTheme;
  draftSettings?: FunnelSettingsDto;
  draftRules?: Record<string, NextRule[]>;
  draftDefaultNext?: Record<string, string | null>;
}

interface RawFunnelRow {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  draftPagesJson: unknown;
  draftThemeJson: unknown;
  draftSettingsJson: unknown;
  createdAt: string;
  updatedAt: string;
}

interface RawPageWithBranching {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  next_rules?: NextRule[];
  default_next?: string | null;
  [key: string]: unknown;
}

// The API stores branching rules and default_next on each page in
// draftPagesJson. The UI binds rules + defaultNext as flat maps keyed
// by page id — decompose on read, recompose on write.
function decompose(row: RawFunnelRow): FunnelDetailDto {
  const rawPages = (row.draftPagesJson ?? []) as RawPageWithBranching[];
  const rules: Record<string, NextRule[]> = {};
  const defaultNext: Record<string, string | null> = {};
  const pages: RawPageWithBranching[] = rawPages.map((p) => {
    const { next_rules, default_next, ...rest } = p;
    if (next_rules && next_rules.length > 0) rules[p.id] = next_rules;
    if (default_next !== undefined) defaultNext[p.id] = default_next;
    return rest as RawPageWithBranching;
  });
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    status: row.status,
    currentVersionId: row.currentVersionId,
    currentVersionNo: null,
    draftPages: pages as unknown as PagesArray,
    draftTheme: (row.draftThemeJson ?? {}) as FunnelTheme,
    draftSettings: (row.draftSettingsJson ?? {}) as FunnelSettingsDto,
    draftRules: rules,
    draftDefaultNext: defaultNext,
    draftDiffersFromPublished: row.currentVersionId !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recomposePages(
  pages: PagesArray,
  rules: Record<string, NextRule[]>,
  defaultNext: Record<string, string | null>,
): unknown[] {
  return (pages as unknown as RawPageWithBranching[]).map((p) => ({
    ...p,
    next_rules: rules[p.id] ?? [],
    default_next: defaultNext[p.id] ?? undefined,
  }));
}

@injectable()
export class FunnelApi {
  async get(projectId: string, funnelId: string, signal?: AbortSignal): Promise<FunnelDetailDto> {
    const row = await unwrap<RawFunnelRow>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].$get(
        { param: { projectId, funnelId } },
        { init: { signal } },
      ),
    );
    return decompose(row);
  }

  async patchDraft(
    projectId: string,
    funnelId: string,
    payload: PatchDraftPayload,
    signal?: AbortSignal,
  ): Promise<FunnelDetailDto> {
    const body: Record<string, unknown> = {};
    if (payload.name !== undefined) body.name = payload.name;
    if (payload.slug !== undefined) body.slug = payload.slug;
    if (payload.draftPages !== undefined) {
      body.draft_pages_json = recomposePages(
        payload.draftPages,
        payload.draftRules ?? {},
        payload.draftDefaultNext ?? {},
      );
    }
    if (payload.draftTheme !== undefined) body.draft_theme_json = payload.draftTheme;
    if (payload.draftSettings !== undefined) body.draft_settings_json = payload.draftSettings;

    const row = await unwrap<RawFunnelRow>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].$patch(
        { param: { projectId, funnelId }, json: body as never },
        { init: { signal } },
      ),
    );
    return decompose(row);
  }

  async publish(
    projectId: string,
    funnelId: string,
  ): Promise<{ funnel: FunnelDetailDto; versionNo: number }> {
    const result = await unwrap<{ version_id: string; version_no: number }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].publish.$post({
        param: { projectId, funnelId },
      }),
    );
    const refreshed = await this.get(projectId, funnelId);
    refreshed.currentVersionId = result.version_id;
    refreshed.currentVersionNo = result.version_no;
    return { funnel: refreshed, versionNo: result.version_no };
  }

  async duplicate(projectId: string, funnelId: string): Promise<FunnelDetailDto> {
    const row = await unwrap<RawFunnelRow>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].duplicate.$post({
        param: { projectId, funnelId },
      }),
    );
    return decompose(row);
  }
}
