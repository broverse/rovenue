// NOTE: the Cargo package name is `librovenue` but `[lib] name = "rovenue"`
// (per spec §8.2 — final dylib is `librovenue.{a,dylib,so}` and C symbols are `rovenue_*`).
// The Rust import path therefore uses `rovenue`, not `librovenue`.
use rovenue::version::SDK_VERSION;

#[test]
fn sdk_version_matches_cargo_pkg_version() {
    assert_eq!(SDK_VERSION, env!("CARGO_PKG_VERSION"));
}

#[test]
fn sdk_version_is_semver() {
    let parts: Vec<&str> = SDK_VERSION.split('.').collect();
    assert_eq!(parts.len(), 3, "SDK_VERSION must be MAJOR.MINOR.PATCH");
    for p in parts {
        p.parse::<u32>().expect("each segment must be numeric");
    }
}
