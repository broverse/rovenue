import { useTranslation } from "react-i18next";
import { CodeBlock } from "../../ui/code-block";
import { API_BASE_URL } from "../../lib/api";

export function McpEndpointCard() {
  const { t } = useTranslation();
  const endpoint = `${API_BASE_URL}/mcp`;
  const snippet = [
    `{`,
    `  "mcpServers": {`,
    `    "rovenue": {`,
    `      "url": "${endpoint}",`,
    `      "headers": { "Authorization": "Bearer rov_mcp_…" }`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-4 py-4 sm:px-5">
        <h3 className="text-[14px] font-semibold leading-5 text-foreground">
          {t("mcp.endpoint.title")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
          {t("mcp.endpoint.subtitle", { endpoint })}
        </p>
      </header>
      <div className="px-4 py-4 sm:px-5">
        <CodeBlock code={snippet} language="json" filename="mcp.json" />
      </div>
    </section>
  );
}
