import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { Button } from "../../../../ui/button";
import { CreateMcpTokenDialog } from "../../../../components/mcp/create-mcp-token-dialog";
import { McpEndpointCard } from "../../../../components/mcp/mcp-endpoint-card";
import { McpTokensCard } from "../../../../components/mcp/mcp-tokens-card";
import { useMcpTokens } from "../../../../lib/hooks/useMcpTokens";

export const Route = createFileRoute("/_authed/projects/$projectId/mcp")({
  component: McpRoute,
});

function McpRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/mcp" });
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const tokensQuery = useMcpTokens(projectId);

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[20px] font-semibold leading-7 tracking-tight sm:text-[24px] sm:leading-8">
            {t("mcp.title")}
          </h1>
          <p className="mt-1 text-[12.5px] text-rv-mute-500 sm:text-[13px]">
            {t("mcp.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="flat" size="sm" onClick={() => setCreateOpen(true)}>
            <Bot size={13} />
            {t("mcp.actions.create")}
          </Button>
        </div>
      </header>

      {tokensQuery.isPending && (
        <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-8 text-center text-[12px] text-rv-mute-500">
          {t("mcp.loading")}
        </div>
      )}
      {tokensQuery.isError && (
        <div className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-4 text-sm text-danger-700">
          {tokensQuery.error instanceof Error
            ? tokensQuery.error.message
            : t("mcp.failed")}
        </div>
      )}
      {tokensQuery.data && (
        <>
          <McpEndpointCard />
          <McpTokensCard
            projectId={projectId}
            tokens={tokensQuery.data}
            onCreate={() => setCreateOpen(true)}
          />
        </>
      )}

      <CreateMcpTokenDialog
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
