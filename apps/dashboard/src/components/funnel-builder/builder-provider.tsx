import { ServiceProvider } from "impair";
import type { ReactNode } from "react";
import { FunnelApi } from "../../lib/services/funnel-api";
import { FunnelVersionsApi } from "../../lib/services/funnel-versions-api";
import { FunnelSessionsApi } from "../../lib/services/funnel-sessions-api";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelSessionsViewModel } from "./vm/funnel-sessions.vm";

interface Props {
  projectId: string;
  funnelId: string;
  children: ReactNode;
}

export function BuilderProvider({ projectId, funnelId, children }: Props) {
  return (
    <ServiceProvider
      provide={[
        FunnelApi,
        FunnelVersionsApi,
        FunnelSessionsApi,
        FunnelDraftViewModel,
        FunnelSessionsViewModel,
      ]}
      props={{ projectId, funnelId }}
    >
      {children}
    </ServiceProvider>
  );
}
