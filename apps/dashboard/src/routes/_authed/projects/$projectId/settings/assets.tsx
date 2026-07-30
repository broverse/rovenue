import { createFileRoute, useParams } from "@tanstack/react-router";
import { AssetLibrary } from "../../../../../components/assets/asset-library";

// =============================================================
// /projects/:projectId/settings/assets
// =============================================================
//
// Mirrors settings/fonts.tsx (FontsPage): `AssetLibrary` is already a
// complete, self-contained project-scoped screen (own hooks, own
// upload/delete dialogs) — this file only resolves `:projectId` off
// the route and renders it. Without this route (and the sidebar tab
// added alongside it in settings/route.tsx), the asset library and
// the paywall builder's asset picker are unreachable: nothing lets an
// author ever upload the first asset for a project.

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/assets",
)({
  component: AssetsRoute,
});

function AssetsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/assets",
  });
  return <AssetLibrary projectId={projectId} />;
}
