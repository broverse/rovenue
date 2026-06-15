import { useMemo, useState } from "react";
import { component, useService } from "impair";
import { ArrowRight, Check, Copy, Link } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const ShareTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const domain = vm.settings.universalLinkDomain;
  const baseUrl = domain ? `https://${domain}/${vm.slug}` : null;
  const [utm, setUtm] = useState({
    source: "tiktok",
    medium: "cpc",
    campaign: "launch",
  });
  const utmUrl = baseUrl
    ? `${baseUrl}?utm_source=${utm.source}&utm_medium=${utm.medium}&utm_campaign=${utm.campaign}`
    : null;

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4">
        {vm.status !== "published" ? (
          <Card>
            <h3 className="m-0 mb-1 text-[14px] font-semibold">Publish to share</h3>
            <p className="m-0 mb-4 text-[12px] leading-relaxed text-rv-mute-500">
              This funnel is in <span className="text-rv-warning">{vm.status}</span>. Publish a
              version before sending traffic to it. The public URL is reserved by your slug.
            </p>
            <button
              type="button"
              onClick={() => {
                if (vm.errorCount > 0) vm.openValidation();
                else void vm.publish();
              }}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-rv-accent-500 px-3 text-[13px] font-medium text-white transition hover:bg-rv-accent-600"
            >
              <Check size={13} />
              {vm.errorCount > 0 ? "Fix issues first" : "Publish now"}
            </button>
          </Card>
        ) : !baseUrl ? (
          <Card>
            <h3 className="m-0 mb-1 text-[14px] font-semibold">Set a universal link domain</h3>
            <p className="m-0 mb-4 text-[12px] leading-relaxed text-rv-mute-500">
              You're published, but no universal-link domain is set. Open Settings → Hand-off and
              point a domain at <span className="font-rv-mono">claim.rovenue.io</span>.
            </p>
            <button
              type="button"
              onClick={() => vm.setActiveTab("settings")}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-rv-accent-500 px-3 text-[13px] font-medium text-white transition hover:bg-rv-accent-600"
            >
              Open Settings
            </button>
          </Card>
        ) : (
          <>
            <Card>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="m-0 text-[14px] font-semibold">Public URL</h3>
                  <p className="m-0 mt-0.5 text-[12px] text-rv-mute-500">
                    Hosted by Rovenue. Universal link automatically deep-links to the app if
                    installed.
                  </p>
                </div>
                <span className="inline-flex h-5 items-center gap-1 rounded-full bg-rv-success/15 px-2 font-rv-mono text-[10px] font-medium text-rv-success">
                  ● Live · v{vm.funnel?.currentVersionNo ?? "?"}
                </span>
              </div>
              <div className="mt-3.5 flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                <Link size={14} className="text-rv-mute-500" />
                <div className="flex-1 truncate font-rv-mono text-[13px]">
                  <span className="text-rv-mute-500">https://{domain}/</span>
                  <span className="text-foreground">{vm.slug}</span>
                </div>
                <ActionBtn onClick={() => navigator.clipboard?.writeText(baseUrl)}>
                  <Copy size={12} />
                  Copy
                </ActionBtn>
                <ActionBtn onClick={() => window.open(baseUrl, "_blank")}>
                  <ArrowRight size={12} />
                  Open
                </ActionBtn>
              </div>
            </Card>

            <Card>
              <h3 className="m-0 mb-3.5 text-[14px] font-semibold">QR code</h3>
              <div className="flex flex-wrap items-start gap-5">
                <div className="h-[140px] w-[140px] flex-shrink-0 overflow-hidden rounded-md border border-rv-divider bg-white p-2">
                  <QRPlaceholder />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="m-0 mb-3 text-[13px] leading-relaxed text-rv-mute-700">
                    Drop this on printed material, in your slide deck, or scan to test the live
                    funnel on a real device.
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <h3 className="m-0 mb-3.5 text-[14px] font-semibold">Snippets</h3>

              <SnippetCard title="Raw URL" desc="For plain links in email, slides, ad creatives.">
                <pre className="m-0 overflow-x-auto bg-rv-c2 px-3.5 py-3 font-rv-mono text-[11px] text-foreground">
                  {baseUrl}
                </pre>
              </SnippetCard>

              <SnippetCard
                title="UTM-tagged URL"
                desc="Source / medium / campaign attribution. Shows up on the Sessions tab."
              >
                <div className="grid grid-cols-3 gap-2.5 border-b border-rv-divider px-3.5 py-3">
                  {(
                    [
                      ["Source", "source"],
                      ["Medium", "medium"],
                      ["Campaign", "campaign"],
                    ] as const
                  ).map(([label, key]) => (
                    <div key={key}>
                      <div className="mb-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                        {label}
                      </div>
                      <input
                        value={utm[key]}
                        onChange={(e) => setUtm((u) => ({ ...u, [key]: e.target.value }))}
                        className="h-7 w-full rounded border border-rv-divider bg-rv-c1 px-2 font-rv-mono text-[11px] text-foreground outline-none focus:border-rv-accent-500"
                      />
                    </div>
                  ))}
                </div>
                <pre className="m-0 overflow-x-auto bg-rv-c2 px-3.5 py-3 font-rv-mono text-[11px] text-foreground">
                  {utmUrl}
                </pre>
              </SnippetCard>

              <SnippetCard
                title="Universal-link <a> tag"
                desc="For dropping into your marketing site — deep-links to the app with store fallback."
              >
                <pre className="m-0 overflow-x-auto bg-rv-c2 px-3.5 py-3 font-rv-mono text-[11px] leading-relaxed text-foreground">
                  <span className="text-rv-accent-400">{`<a `}</span>href=
                  <span className="text-rv-success">{`"${baseUrl}"`}</span>
                  {"\n   "}data-fallback-ios=
                  <span className="text-rv-success">{`"${vm.settings.iosUrl}"`}</span>
                  {"\n   "}data-fallback-android=
                  <span className="text-rv-success">{`"${vm.settings.androidUrl}"`}</span>
                  <span className="text-rv-accent-400">{`>`}</span>
                  {"\n  Start onboarding\n"}
                  <span className="text-rv-accent-400">{`</a>`}</span>
                </pre>
              </SnippetCard>
            </Card>
          </>
        )}
      </div>
    </div>
  );
});

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">{children}</section>
  );
}

function ActionBtn({
  children,
  size = "sm",
  onClick,
}: {
  children: React.ReactNode;
  size?: "sm" | "md";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1 rounded border border-rv-divider bg-rv-c1 px-2.5 text-[11px] font-medium text-rv-mute-700 transition hover:bg-rv-c3 hover:text-foreground ${
        size === "md" ? "h-8 text-[12px]" : "h-7"
      }`}
    >
      {children}
    </button>
  );
}

function SnippetCard({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 overflow-hidden rounded-md border border-rv-divider bg-rv-c2 last:mb-0">
      <div className="flex items-start justify-between gap-2 border-b border-rv-divider px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-[12px] font-semibold">{title}</h4>
          <div className="mt-0.5 text-[10px] text-rv-mute-500">{desc}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function QRPlaceholder() {
  const cells = useMemo(() => {
    const seed = 0xc0ffee;
    let s = seed;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const acc: Array<[number, number]> = [];
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const inFinder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
        if (inFinder) {
          const cx = x < 7 ? 3 : 17;
          const cy = y < 7 ? 3 : 17;
          const m = Math.max(Math.abs(x - cx), Math.abs(y - cy));
          if (m === 0 || m === 2 || m === 3) acc.push([x, y]);
        } else if (rand() > 0.55) acc.push([x, y]);
      }
    }
    return acc;
  }, []);
  return (
    <svg viewBox="0 0 21 21" shapeRendering="crispEdges" className="h-full w-full">
      <rect width="21" height="21" fill="white" />
      {cells.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width="1" height="1" fill="#0F0F12" />
      ))}
    </svg>
  );
}
