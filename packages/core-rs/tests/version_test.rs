use librovenue::version::SDK_VERSION;

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
