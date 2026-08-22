import { createFileRoute, useParams } from "@tanstack/react-router";
import { AssetLibrary } from "../../../../components/assets/asset-library";

// =============================================================
// /projects/:projectId/assets
// =============================================================
//
// `AssetLibrary` is a complete, self-contained project-scoped screen
// (own hooks, own upload/delete dialogs), so this file only resolves
// `:projectId` off the route and renders it.
//
// Lives under GROWTH in the main sidebar (components/dashboard/
// navigation.ts), not under Settings, where it originally shipped:
// uploading a paywall image is authoring work an author does mid-build,
// not project configuration they set once. Settings still owns fonts —
// a font family is registered once and then referenced by name, whereas
// assets are added continuously alongside the paywalls that use them.

export const Route = createFileRoute("/_authed/projects/$projectId/assets")({
  component: AssetsRoute,
});

function AssetsRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/assets" });
  return <AssetLibrary projectId={projectId} />;
}
