import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { FunnelDetailDto } from "./funnel-api";

export interface FunnelTemplateDto {
  id: string;
  name: string;
  category: string;
  description: string | null;
  previewImageUrl: string | null;
  scope: "system" | "user";
}

interface RawTemplateRow {
  id: string;
  name: string;
  category: string;
  description: string | null;
  previewImageUrl: string | null;
  scope: "system" | "user";
  [key: string]: unknown;
}

interface RawFunnelRow {
  id: string;
  [key: string]: unknown;
}

@injectable()
export class FunnelTemplatesApi {
  async list(): Promise<FunnelTemplateDto[]> {
    const result = await unwrap<{ templates: RawTemplateRow[] }>(
      rpc.dashboard["funnel-templates"].$get(),
    );
    return result.templates.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      previewImageUrl: t.previewImageUrl,
      scope: t.scope,
    }));
  }

  async createFromTemplate(
    projectId: string,
    templateId: string,
  ): Promise<FunnelDetailDto> {
    const row = await unwrap<RawFunnelRow>(
      rpc.dashboard.projects[":projectId"].funnels["from-template"][":templateId"].$post({
        param: { projectId, templateId },
      }),
    );
    return row as unknown as FunnelDetailDto;
  }
}
