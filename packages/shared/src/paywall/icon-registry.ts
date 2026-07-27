import registry from "./icon-registry.json";

export type IconRegistryEntry = {
  name: string;
  /** lucide-react export name. */
  web: string;
  /** Directory in google/material-design-icons: android/<category>/<icon>/… */
  androidCategory: string;
  androidIcon: string;
  /** SF Symbol name. */
  ios: string;
};

export const iconRegistry: readonly IconRegistryEntry[] = registry.icons;

export const ICON_NAMES: readonly string[] = iconRegistry.map((i) => i.name);

const KNOWN = new Set(ICON_NAMES);

/** Registry membership. Rendering must NOT depend on this — an unknown name
 *  renders nothing and fails open. This exists for the authoring warning. */
export function isKnownIconName(name: string): boolean {
  return KNOWN.has(name);
}
