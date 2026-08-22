import type { TFunction } from "i18next";
import type { AssetKind } from "@rovenue/shared";

// Shared by asset-library.tsx and asset-library-modal.tsx. A `switch`
// over the (narrow, exhaustive) AssetKind union rather than
// `t(\`settings.assets.kind.${kind}\`)` — every t() key in this repo
// must be a static string literal so it stays greppable; a
// template-literal key is exactly the pattern this repo has been
// bitten by before.
export function kindLabel(t: TFunction, kind: AssetKind): string {
  switch (kind) {
    case "image":
      return t("settings.assets.kind.image", "Image");
    case "video":
      return t("settings.assets.kind.video", "Video");
    case "lottie":
      return t("settings.assets.kind.lottie", "Lottie");
  }
}
