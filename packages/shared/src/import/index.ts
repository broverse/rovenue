export * from "./canonical";
export * from "./constants";
export * from "./csv";
export * from "./presets";
export * from "./mapping";
export * from "./normalize";
export * from "./normalize-enrichment";

// `./keys` is intentionally NOT re-exported here — it depends on
// `node:crypto` and would crash the dashboard Vite bundle (this barrel
// is reached from the `@rovenue/shared` root export, which the
// dashboard's mapping UI imports directly). Server-side callers
// (the dry-run planner, the writer) import it explicitly via
// `@rovenue/shared/import/keys`, matching how `./crypto` and
// `./experiments` are handled at the package root — see the comments
// in packages/shared/src/index.ts.
