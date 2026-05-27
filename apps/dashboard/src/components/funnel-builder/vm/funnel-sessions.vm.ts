import { injectable, inject, state, derived, trigger, type Cleanup } from "impair";
import {
  FunnelSessionsApi,
  type FunnelSessionRowDto,
  type FunnelSessionsStatsDto,
  type Range,
} from "../../../lib/services/funnel-sessions-api";
import { FunnelDraftViewModel } from "./funnel-draft.vm";

@injectable()
export class FunnelSessionsViewModel {
  @state range: Range = "7d";
  @state isLoading = true;
  @state sessions: FunnelSessionRowDto[] = [];
  @state stats: FunnelSessionsStatsDto | null = null;
  @state openSessionId: string | null = null;

  constructor(
    @inject(FunnelSessionsApi) private api: FunnelSessionsApi,
    @inject(FunnelDraftViewModel) private draft: FunnelDraftViewModel,
  ) {}

  setRange(r: Range) {
    this.range = r;
  }
  open(id: string) {
    this.openSessionId = id;
  }
  close() {
    this.openSessionId = null;
  }

  @derived get pageById() {
    return new Map(this.draft.pages.map((p) => [p.id, p] as const));
  }

  @trigger
  async load(cleanup: Cleanup) {
    if (!this.draft.funnel) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    this.isLoading = true;
    try {
      const data = await this.api.list(
        this.draft.projectId,
        this.draft.funnelId,
        this.range,
        controller.signal,
      );
      this.sessions = data.sessions;
      this.stats = data.stats;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
    } finally {
      this.isLoading = false;
    }
  }
}
