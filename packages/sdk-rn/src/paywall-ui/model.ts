// =============================================================
// Builder-config model — React Native's platform decoder for the
// Phase-B component tree, mirroring the Swift (Codable) and Kotlin
// (JsonElement-walking) decoders and pinned by the same shared
// contract file, packages/shared/src/paywall/render-fixtures.json.
//
// Decoding contract (see the fixture's `_comment`):
//  - an unrecognized node `type` decodes LENIENTLY to an `unknown`
//    node retaining `id` + `fallback` (the renderer draws the
//    fallback or nothing) — never an error;
//  - any structural defect in a KNOWN type (bad enum value, missing
//    `id`, malformed `fallback` subtree, formatVersion !== 2,
//    non-object localization table, non-stack root) fails the WHOLE
//    decode — `decodeBuilderConfig` returns null.
//
// The strict authoring schema lives in @rovenue/shared/paywall; this
// decoder is deliberately looser on unknown types only. Input is the
// ALREADY-PARSED object (`paywall.builderConfig`), not a JSON string.
// =============================================================

export type ThemePair = { light: string; dark?: string };
export type NodeSize = "fit" | "fill" | number;
export type Padding = { t?: number; r?: number; b?: number; l?: number };
export type SizeSpec = { width?: NodeSize; height?: NodeSize };
export type Axis = "v" | "h" | "z";
export type HAlign = "start" | "center" | "end";
export type TextRole = "title" | "subtitle" | "body" | "caption";
export type ButtonVisualStyle = "primary" | "secondary" | "plain";
export type CellLayout = "row" | "column";
export type ButtonAction =
  | { kind: "close" }
  | { kind: "restore" }
  | { kind: "url"; url: string };

export type BuilderNode =
  | {
      type: "stack";
      id: string;
      axis: Axis;
      children: BuilderNode[];
      spacing?: number;
      align?: HAlign;
      padding?: Padding;
      size?: SizeSpec;
      background?: ThemePair;
      cornerRadius?: number;
      fallback?: BuilderNode;
    }
  | { type: "text"; id: string; key: string; role: TextRole; color?: ThemePair; align?: HAlign; fallback?: BuilderNode }
  | { type: "image"; id: string; url: ThemePair; height?: number; cornerRadius?: number; alt?: string; fallback?: BuilderNode }
  | { type: "button"; id: string; labelKey: string; style: ButtonVisualStyle; action: ButtonAction; fallback?: BuilderNode }
  | { type: "packageList"; id: string; packageIds: string[]; defaultSelected?: string; cellLayout: CellLayout; fallback?: BuilderNode }
  | { type: "purchaseButton"; id: string; labelKey: string; fallback?: BuilderNode }
  | { type: "spacer"; id: string; size?: number; fallback?: BuilderNode }
  | { type: "unknown"; id: string; fallback?: BuilderNode };

export type BuilderConfigModel = {
  formatVersion: 2;
  defaultLocale: string;
  localizations: Record<string, Record<string, string>>;
  background?: ThemePair;
  root: Extract<BuilderNode, { type: "stack" }>;
};

class DecodeError extends Error {}

/**
 * Decodes an already-parsed builder-config object. Returns null on ANY
 * structural defect — never throws. Unknown node types decode leniently.
 */
export function decodeBuilderConfig(raw: unknown): BuilderConfigModel | null {
  try {
    return parseConfig(asObject(raw, "config"));
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;

function asObject(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new DecodeError(`${what} must be an object`);
  }
  return v as Obj;
}

function requireString(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new DecodeError(`${key} must be a string`);
  return v;
}

function optionalString(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new DecodeError(`${key} must be a string`);
  return v;
}

function optionalNumber(o: Obj, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DecodeError(`${key} must be a number`);
  return v;
}

function requireEnum<T extends string>(o: Obj, key: string, allowed: readonly T[]): T {
  const v = requireString(o, key);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new DecodeError(`${key} has invalid value "${v}"`);
  }
  return v as T;
}

function optionalEnum<T extends string>(o: Obj, key: string, allowed: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new DecodeError(`${key} has invalid value`);
  }
  return v as T;
}

function parseThemePair(v: unknown, what: string): ThemePair {
  const o = asObject(v, what);
  return { light: requireString(o, "light"), dark: optionalString(o, "dark") };
}

function parseNodeSize(v: unknown): NodeSize {
  if (v === "fit" || v === "fill") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new DecodeError('NodeSize must be "fit", "fill", or a number');
}

function parseConfig(o: Obj): BuilderConfigModel {
  if (o.formatVersion !== 2) throw new DecodeError("formatVersion must be the literal 2");
  const defaultLocale = requireString(o, "defaultLocale");
  if (defaultLocale === "") throw new DecodeError("defaultLocale must be non-empty");

  const locsObj = asObject(o.localizations, "localizations");
  const localizations: Record<string, Record<string, string>> = {};
  for (const [locale, table] of Object.entries(locsObj)) {
    const tableObj = asObject(table, `localizations[${locale}]`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(tableObj)) {
      if (typeof value !== "string") {
        throw new DecodeError(`localizations[${locale}][${key}] must be a string`);
      }
      out[key] = value;
    }
    localizations[locale] = out;
  }

  const background = o.background === undefined || o.background === null
    ? undefined
    : parseThemePair(o.background, "background");

  const root = parseNode(asObject(o.root, "root"));
  if (root.type !== "stack") throw new DecodeError("root must be a stack node");

  return { formatVersion: 2, defaultLocale, localizations, background, root };
}

function parseNode(o: Obj): BuilderNode {
  const type = requireString(o, "type");
  const id = requireString(o, "id");
  const fallback = o.fallback === undefined || o.fallback === null
    ? undefined
    : parseNode(asObject(o.fallback, "fallback"));

  switch (type) {
    case "stack": {
      const childrenRaw = o.children;
      if (!Array.isArray(childrenRaw)) throw new DecodeError("stack.children must be an array");
      return {
        type,
        id,
        axis: requireEnum(o, "axis", ["v", "h", "z"] as const),
        children: childrenRaw.map((c) => parseNode(asObject(c, "child"))),
        spacing: optionalNumber(o, "spacing"),
        align: optionalEnum(o, "align", ["start", "center", "end"] as const),
        padding: o.padding === undefined || o.padding === null
          ? undefined
          : (() => {
              const p = asObject(o.padding, "padding");
              return {
                t: optionalNumber(p, "t"),
                r: optionalNumber(p, "r"),
                b: optionalNumber(p, "b"),
                l: optionalNumber(p, "l"),
              };
            })(),
        size: o.size === undefined || o.size === null
          ? undefined
          : (() => {
              const s = asObject(o.size, "size");
              return {
                width: s.width === undefined || s.width === null ? undefined : parseNodeSize(s.width),
                height: s.height === undefined || s.height === null ? undefined : parseNodeSize(s.height),
              };
            })(),
        background: o.background === undefined || o.background === null
          ? undefined
          : parseThemePair(o.background, "stack.background"),
        cornerRadius: optionalNumber(o, "cornerRadius"),
        fallback,
      };
    }
    case "text":
      return {
        type,
        id,
        key: requireString(o, "key"),
        role: requireEnum(o, "role", ["title", "subtitle", "body", "caption"] as const),
        color: o.color === undefined || o.color === null ? undefined : parseThemePair(o.color, "text.color"),
        align: optionalEnum(o, "align", ["start", "center", "end"] as const),
        fallback,
      };
    case "image":
      return {
        type,
        id,
        url: parseThemePair(o.url, "image.url"),
        height: optionalNumber(o, "height"),
        cornerRadius: optionalNumber(o, "cornerRadius"),
        alt: optionalString(o, "alt"),
        fallback,
      };
    case "button": {
      const action = asObject(o.action, "button.action");
      const kind = requireString(action, "kind");
      let parsedAction: ButtonAction;
      if (kind === "close") parsedAction = { kind };
      else if (kind === "restore") parsedAction = { kind };
      else if (kind === "url") parsedAction = { kind, url: requireString(action, "url") };
      else throw new DecodeError(`unknown button action kind "${kind}"`);
      return {
        type,
        id,
        labelKey: requireString(o, "labelKey"),
        style: requireEnum(o, "style", ["primary", "secondary", "plain"] as const),
        action: parsedAction,
        fallback,
      };
    }
    case "packageList": {
      const idsRaw = o.packageIds;
      if (!Array.isArray(idsRaw)) throw new DecodeError("packageList.packageIds must be an array");
      const packageIds = idsRaw.map((v) => {
        if (typeof v !== "string") throw new DecodeError("packageIds entries must be strings");
        return v;
      });
      return {
        type,
        id,
        packageIds,
        defaultSelected: optionalString(o, "defaultSelected"),
        cellLayout: requireEnum(o, "cellLayout", ["row", "column"] as const),
        fallback,
      };
    }
    case "purchaseButton":
      return { type, id, labelKey: requireString(o, "labelKey"), fallback };
    case "spacer":
      return { type, id, size: optionalNumber(o, "size"), fallback };
    default:
      // Lenient branch: unknown types keep id + fallback and never fail
      // the decode; the fallback subtree above was still parsed strictly.
      return { type: "unknown", id, fallback };
  }
}
