fn main() {
    // UDL must live at <crate_root>/src/<name>.udl so that uniffi 0.25 can
    // walk two parents up to find Cargo.toml when guessing the crate root.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let udl_path = format!("{manifest_dir}/src/librovenue.udl");
    uniffi::generate_scaffolding(udl_path).expect("uniffi scaffolding generation failed");
}
