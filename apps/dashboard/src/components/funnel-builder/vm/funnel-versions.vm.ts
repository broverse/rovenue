import { injectable, inject, state, trigger, type Cleanup } from "impair";
import {
  FunnelVersionsApi,
  type FunnelVersionDto,
} from "../../../lib/services/funnel-versions-api";
import { FunnelDraftViewModel } from "./funnel-draft.vm";

@injectable()
export class FunnelVersionsViewModel {
  @state isLoading = false;
  @state versions: FunnelVersionDto[] = [];

  constructor(
    @inject(FunnelVersionsApi) private api: FunnelVersionsApi,
    @inject(FunnelDraftViewModel) private draft: FunnelDraftViewModel,
  ) {}

  @trigger
  async load(cleanup: Cleanup) {
    if (!this.draft.funnel) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    this.isLoading = true;
    try {
      const list = await this.api.list(this.draft.projectId, this.draft.funnelId);
      const currentId = this.draft.funnel?.currentVersionId;
      // Overlay isCurrent against the draft VM's known current version id —
      // the API list endpoint doesn't carry that signal.
      this.versions = list.map((v) => ({
        ...v,
        isCurrent: currentId !== null && v.id === currentId,
      }));
    } finally {
      this.isLoading = false;
    }
  }

  async revert(versionId: string) {
    await this.api.revert(this.draft.projectId, this.draft.funnelId, versionId);
    await this.draft.discardDraft();
  }
}
