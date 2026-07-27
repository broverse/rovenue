# Vendored icons

The twelve `rovenue_ic_*.xml` VectorDrawables in this directory are vendored
from [google/material-design-icons](https://github.com/google/material-design-icons)
(Apache License 2.0), fetched from paths of the form:

```
https://raw.githubusercontent.com/google/material-design-icons/master/android/<category>/<icon>/materialicons/black/res/drawable/baseline_<icon>_24.xml
```

See `packages/shared/src/paywall/icon-registry.json` for the semantic name ->
`androidCategory`/`androidIcon` mapping used to resolve each fetch path, and
`drawableResFor` in `BuilderConfigModel.kt` for the semantic name -> vendored
drawable resource id mapping (a static `R.drawable.*` reference, not a runtime
`getIdentifier` lookup) used at render time.

`android:tint="?attr/colorControlNormal"` was stripped from every fetched
file — the paywall `icon` node supplies its own colour via `IconOverrideProps`
and the theme attribute would otherwise override it.

Every file's `<path>` carries `android:fillColor="@android:color/white"`
(Material's fetch path above is the "black" icon set, but that variant still
ships a white fill) — a consuming app that references one of these drawables
directly, without applying its own tint, gets a white glyph that disappears
against a white/light background.
