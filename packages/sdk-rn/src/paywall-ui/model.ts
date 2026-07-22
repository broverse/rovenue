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
// Phase D2 (overrides/cellTemplate): every known node type carries an
// optional `overrides?: NodeOverride[]`; `packageList` also gains an
// optional `cellTemplate?: BuilderNode`. An `overrides` entry whose
// `when.kind` is outside the two known literals decodes to the
// RETAINED-but-never-matching sentinel `{ kind: "unknown" }` — this is
// LENIENT (does not fail the config), mirroring the `.unknown` case in
// the Swift/Kotlin decoders. A structural/non-whitelisted prop key
// under a KNOWN kind (e.g. `type` inside `introEligible`'s `props`)
// fails the WHOLE config decode, same as any other structural defect.
//
// The strict authoring schema lives in @rovenue/shared/paywall; this
// decoder is deliberately looser on unknown types/override kinds only.
// Input is the ALREADY-PARSED object (`paywall.builderConfig`), not a
// JSON string.
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

// -------------------------------------------------------------
// Overrides (Phase D2) — conditional prop swaps evaluated at render
// time (see ./overrides.ts's `applyOverrides`). Mirrors
// packages/shared/src/paywall/schema.ts's OverrideCondition/NodeOverride,
// adapted for this lenient decoder: an unrecognized `when.kind` decodes
// to the `{ kind: "unknown" }` sentinel — RETAINED in the array but never
// active — instead of failing the decode.
// -------------------------------------------------------------

export type OverrideCondition =
  | { kind: "introEligible" }
  | { kind: "selected" }
  | { kind: "unknown" };

export type NodeOverride = {
  when: OverrideCondition;
  /**
   * Present (and validated against the node type's whitelist) ONLY for a
   * KNOWN when.kind. Deliberately left `undefined` — not decoded or
   * validated at all — for an unknown when.kind, since such an entry can
   * never become active (see applyOverrides).
   */
  props?: Record<string, unknown>;
};

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
      overrides?: NodeOverride[];
      fallback?: BuilderNode;
    }
  | {
      type: "text";
      id: string;
      key: string;
      role: TextRole;
      color?: ThemePair;
      align?: HAlign;
      overrides?: NodeOverride[];
      fallback?: BuilderNode;
    }
  | {
      type: "image";
      id: string;
      url: ThemePair;
      height?: number;
      cornerRadius?: number;
      alt?: string;
      overrides?: NodeOverride[];
      fallback?: BuilderNode;
    }
  | {
      type: "button";
      id: string;
      labelKey: string;
      style: ButtonVisualStyle;
      action: ButtonAction;
      overrides?: NodeOverride[];
      fallback?: BuilderNode;
    }
  | {
      type: "packageList";
      id: string;
      packageIds: string[];
      defaultSelected?: string;
      cellLayout: CellLayout;
      /**
       * Optional subtree rendered once per effective package, with
       * cell-scoped variables, replacing the built-in (name + price)
       * cell. Absent -> current built-in cell (backward compatible).
       * Recursive, exactly like `fallback`.
       */
      cellTemplate?: BuilderNode;
      overrides?: NodeOverride[];
      fallback?: BuilderNode;
    }
  | { type: "purchaseButton"; id: string; labelKey: string; overrides?: NodeOverride[]; fallback?: BuilderNode }
  | { type: "spacer"; id: string; size?: number; overrides?: NodeOverride[]; fallback?: BuilderNode }
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

// -------------------------------------------------------------
// Overrides decode — per-node-type whitelist of override-able prop
// keys, HARDCODED here mirroring packages/shared/src/paywall/schema.ts's
// `OVERRIDABLE_PROP_KEYS` (the single source of truth for the whitelist —
// keep the two tables in sync by hand).
// -------------------------------------------------------------

type KnownNodeType = Exclude<BuilderNode["type"], "unknown">;

const OVERRIDABLE_PROP_KEYS: Record<KnownNodeType, readonly string[]> = {
  stack: ["spacing", "align", "background", "cornerRadius"],
  text: ["key", "color", "align"],
  image: ["cornerRadius"],
  button: ["labelKey", "style"],
  packageList: [],
  purchaseButton: ["labelKey"],
  spacer: [],
};

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Decodes+validates one override entry's `props` against `type`'s
 * whitelist, with each key typed per its base-node field. Any
 * non-whitelisted key (including a structural field like `type`) throws
 * — propagating up through `parseOverrideEntry`/`parseNode` and failing
 * the WHOLE config decode, per the reject fixture ("structural key 'type'
 * inside override props on a known when.kind").
 */
function parseOverrideProps(type: KnownNodeType, o: Obj): Record<string, unknown> {
  const allowed = new Set(OVERRIDABLE_PROP_KEYS[type]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      throw new DecodeError(`"${key}" is not an overridable prop for the "${type}" node type.`);
    }
  }
  const props: Record<string, unknown> = {};
  switch (type) {
    case "stack":
      setIfDefined(props, "spacing", optionalNumber(o, "spacing"));
      setIfDefined(props, "align", optionalEnum(o, "align", ["start", "center", "end"] as const));
      setIfDefined(
        props,
        "background",
        o.background === undefined || o.background === null
          ? undefined
          : parseThemePair(o.background, "override.background"),
      );
      setIfDefined(props, "cornerRadius", optionalNumber(o, "cornerRadius"));
      break;
    case "text":
      setIfDefined(props, "key", optionalString(o, "key"));
      setIfDefined(
        props,
        "color",
        o.color === undefined || o.color === null ? undefined : parseThemePair(o.color, "override.color"),
      );
      setIfDefined(props, "align", optionalEnum(o, "align", ["start", "center", "end"] as const));
      break;
    case "image":
      setIfDefined(props, "cornerRadius", optionalNumber(o, "cornerRadius"));
      break;
    case "button":
      setIfDefined(props, "labelKey", optionalString(o, "labelKey"));
      setIfDefined(props, "style", optionalEnum(o, "style", ["primary", "secondary", "plain"] as const));
      break;
    case "purchaseButton":
      setIfDefined(props, "labelKey", optionalString(o, "labelKey"));
      break;
    case "packageList":
    case "spacer":
      // Empty whitelist — already validated above (any key present threw);
      // nothing left to decode.
      break;
  }
  return props;
}

/**
 * Decodes a single `overrides[]` entry. An unknown `when.kind` decodes to
 * the RETAINED-but-never-matching sentinel (`props` left `undefined`,
 * deliberately not decoded/validated) — the acceptLenient fixture pins
 * this. A KNOWN kind's `props` IS decoded/validated via
 * `parseOverrideProps`, whose failure propagates up and fails the whole
 * config decode — the reject fixture pins this.
 */
function parseOverrideEntry(o: Obj, type: KnownNodeType): NodeOverride {
  const whenObj = asObject(o.when, "override.when");
  const kind = requireString(whenObj, "kind");
  if (kind !== "introEligible" && kind !== "selected") {
    return { when: { kind: "unknown" } };
  }
  const props = parseOverrideProps(type, asObject(o.props, "override.props"));
  return { when: { kind }, props };
}

function parseOverridesArray(o: Obj, type: KnownNodeType): NodeOverride[] | undefined {
  const raw = o.overrides;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new DecodeError("overrides must be an array");
  return raw.map((entry) => parseOverrideEntry(asObject(entry, "override"), type));
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
        overrides: parseOverridesArray(o, "stack"),
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
        overrides: parseOverridesArray(o, "text"),
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
        overrides: parseOverridesArray(o, "image"),
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
        overrides: parseOverridesArray(o, "button"),
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
      const cellTemplate = o.cellTemplate === undefined || o.cellTemplate === null
        ? undefined
        : parseNode(asObject(o.cellTemplate, "cellTemplate"));
      return {
        type,
        id,
        packageIds,
        defaultSelected: optionalString(o, "defaultSelected"),
        cellLayout: requireEnum(o, "cellLayout", ["row", "column"] as const),
        cellTemplate,
        overrides: parseOverridesArray(o, "packageList"),
        fallback,
      };
    }
    case "purchaseButton":
      return {
        type,
        id,
        labelKey: requireString(o, "labelKey"),
        overrides: parseOverridesArray(o, "purchaseButton"),
        fallback,
      };
    case "spacer":
      return {
        type,
        id,
        size: optionalNumber(o, "size"),
        overrides: parseOverridesArray(o, "spacer"),
        fallback,
      };
    default:
      // Lenient branch: unknown types keep id + fallback and never fail
      // the decode; the fallback subtree above was still parsed strictly.
      // No `overrides` field exists on this case (mirrors Swift's
      // `.unknown(id:fallback:)` / Kotlin's `BuilderNode.Unknown`).
      return { type: "unknown", id, fallback };
  }
}
