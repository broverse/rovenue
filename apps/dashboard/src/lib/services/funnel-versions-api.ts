import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { FunnelDetailDto } from "./funnel-api";

export interface FunnelVersionDto {
  id: string;
  versionNo: number;
  publishedAt: string;
  publishedByName: string | null;
  pageCount: number;
  notes: string | null;
  isCurrent: boolean;
}

interface RawVersionRow {
  id: string;
  version_no: number;
  published_at: string;
  published_by: string | null;
}

interface RawFunnelRow {
  id: string;
  currentVersionId: string | null;
  [key: string]: unknown;
}

@injectable()
export class FunnelVersionsApi {
  async list(projectId: string, funnelId: string): Promise<FunnelVersionDto[]> {
    const result = await unwrap<{ versions: RawVersionRow[] }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].versions.$get({
        param: { projectId, funnelId },
      }),
    );
    // The list endpoint doesn't return the funnel row, so we can't compute
    // isCurrent without a second fetch. Caller-side VMs may overlay it from
    // the draft funnel they already hold; here we default to false.
    return result.versions.map((v) => ({
      id: v.id,
      versionNo: v.version_no,
      publishedAt: v.published_at,
      publishedByName: v.published_by,
      pageCount: 0,
      notes: null,
      isCurrent: false,
    }));
  }

  async revert(
    projectId: string,
    funnelId: string,
    versionId: string,
  ): Promise<FunnelDetailDto> {
    const row = await unwrap<RawFunnelRow>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].revert[":versionId"].$post({
        param: { projectId, funnelId, versionId },
      }),
    );
    return row as unknown as FunnelDetailDto;
  }
}
