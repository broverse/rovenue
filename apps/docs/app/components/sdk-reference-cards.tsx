import { Card, Cards } from 'fumadocs-ui/components/card';

// Slugs must match apps/docs/public/api/<sdk>/ (see .github/workflows/
// sdk-docs.yml and apps/docs/Dockerfile) and __SDK_DOCS_PRESENT__, computed
// at build time in vite.config.ts from whether that directory's index.html
// exists in this build's context.
const SDKS = [
  { slug: 'core-rs', name: 'Rust core (librovenue)', tool: 'rustdoc' },
  { slug: 'sdk-swift', name: 'Swift', tool: 'DocC' },
  { slug: 'sdk-kotlin', name: 'Kotlin', tool: 'Dokka' },
  { slug: 'sdk-rn', name: 'React Native', tool: 'TypeDoc' },
  { slug: 'sdk-web', name: 'Web SDK', tool: 'TypeDoc' },
  { slug: 'sdk-flutter', name: 'Flutter', tool: 'dartdoc' },
] as const;

// One card per SDK, always — whether or not this particular build generated
// that SDK's reference. When present it links to the generated site; when
// absent it says so plainly instead of rendering a link to nothing (Card
// renders as a plain, non-clickable div when it has no `href`).
export function SdkReferenceCards() {
  return (
    <Cards>
      {SDKS.map(({ slug, name, tool }) => {
        const present = __SDK_DOCS_PRESENT__[slug] ?? false;

        return present ? (
          <Card
            key={slug}
            title={name}
            description={`Full API reference, generated with ${tool}.`}
            href={`/api/${slug}/`}
          />
        ) : (
          <Card
            key={slug}
            title={name}
            description={`Not generated in this build. The ${tool} reference for this SDK is produced by CI (.github/workflows/sdk-docs.yml), not this docs build.`}
          />
        );
      })}
    </Cards>
  );
}
