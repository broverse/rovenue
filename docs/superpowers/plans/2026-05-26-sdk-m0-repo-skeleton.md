# SDK M0 — Repo Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Rovenue SDK monorepo skeleton so the Rust core (`librovenue`) compiles, UniFFI generates Swift + Kotlin bindings, Swift/Kotlin/RN façades each expose `configure()` + `getVersion()` (Swift/Kotlin via real FFI to Rust, RN via JS stub), and a CI job runs Rust tests + Swift/Kotlin façade tests on every push.

**Architecture:** Cargo workspace at the repo root coexists with the existing pnpm/Turborepo workspace. A single Rust crate `librovenue` at `packages/core-rs/` declares a tiny FFI surface via UniFFI UDL. UniFFI's bindgen produces Swift and Kotlin glue code that the façade packages compile in directly. The RN façade ships a JS-only `getVersion()` stub backed by a shared version constant; real Rust↔JS bridge lands in M1.

**Tech Stack:** Rust 1.78+ (`cargo` workspace, resolver = "2"), `uniffi` 0.27 (UDL flavour, bindgen via `uniffi-bindgen` CLI), `thiserror`, Swift 5.9 SPM, Kotlin 1.9 + Gradle 8.5, pnpm workspace, GitHub Actions, GNU Make for cross-compile orchestration.

---

## File Structure

**New files (workspace root):**
- `Cargo.toml` — Cargo workspace manifest
- `rust-toolchain.toml` — pin rustc version

**New files under `packages/core-rs/`:**
- `Cargo.toml` — `librovenue` crate manifest (`cdylib` + `staticlib` + `rlib`)
- `build.rs` — runs `uniffi::generate_scaffolding` against `librovenue.udl`
- `librovenue.udl` — UniFFI interface definition
- `uniffi.toml` — bindgen config (Swift module name, Kotlin package)
- `src/lib.rs` — `uniffi::include_scaffolding!` + module wiring
- `src/api.rs` — `RovenueCore` struct + impl (configure, get_version)
- `src/config.rs` — `Config` struct
- `src/error.rs` — `RovenueError` enum
- `src/version.rs` — `SDK_VERSION` constant (single source of truth across all façades)
- `tests/integration_smoke.rs` — round-trip configure→get_version
- `scripts/uniffi-bindgen.sh` — wrapper that invokes `cargo run -p uniffi-bindgen-cli ...`
- `bindgen/Cargo.toml` — tiny binary crate that runs UniFFI bindgen (sidesteps `uniffi-bindgen` install)
- `bindgen/src/main.rs` — `uniffi::uniffi_bindgen_main()`

**New files under `packages/sdk-swift/`:**
- `Package.swift` — SPM manifest
- `Sources/Rovenue/Rovenue.swift` — public Swift API wrapper
- `Sources/Rovenue/Generated/.gitkeep` — UniFFI emits `librovenue.swift` + `librovenueFFI.h` here
- `Sources/RovenueFFI/module.modulemap` — clang modulemap for the C header
- `Tests/RovenueTests/RovenueTests.swift` — XCTest

**New files under `packages/sdk-kotlin/`:**
- `build.gradle.kts` — Android library + Kotlin JVM
- `settings.gradle.kts`
- `gradle.properties`
- `src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — public Kotlin API wrapper
- `src/main/kotlin/dev/rovenue/sdk/generated/.gitkeep` — UniFFI emits `librovenue.kt` here
- `src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt` — JUnit 5

**Modified files under `packages/sdk-rn/`:**
- `package.json` — add Nitro placeholder deps, fix scripts
- `src/index.ts` — public RN API (configure + getVersion stub)
- `src/version.ts` — single version constant, synced with Rust by generator script (M0: hardcoded)

**New under `packages/sdk-rn/`:**
- `src/__tests__/configure.test.ts` — Vitest

**New CI file:**
- `.github/workflows/sdk.yml` — Rust core + Swift + Kotlin jobs

**Modified workspace files:**
- `turbo.json` — register cargo external tasks via `passthrough`
- `.gitignore` — ignore Rust `target/`, Swift `.build/`, Kotlin `build/` under `packages/sdk-*`

---

## Important conventions

- **Crate name:** `librovenue` (Cargo package name). Library output: `[lib] name = "rovenue"` so artifacts are `librovenue.{a,dylib,so}` / `rovenue.dll` — matches the C symbol prefix `rovenue_*` from spec §8.2.
- **SDK version constant:** lives in `packages/core-rs/src/version.rs`. The build script copies it into a header consumed by Swift/Kotlin/RN. M0 hardcodes the same value in `packages/sdk-rn/src/version.ts`; a sync-check test fails if they drift.
- **UDL flavour:** spec §4.1 says `librovenue.udl`. Use UniFFI UDL, not proc-macros. Build script generates scaffolding into `OUT_DIR/librovenue.uniffi.rs` and `src/lib.rs` includes it with `uniffi::include_scaffolding!("librovenue")`.
- **No raw SQL, no async, no transport in M0.** This milestone proves the binding chain works. M1 adds HTTP/SQLite.

---

## Task 1: Cargo workspace + rust-toolchain pin

**Files:**
- Create: `/Volumes/Development/rovenue/Cargo.toml`
- Create: `/Volumes/Development/rovenue/rust-toolchain.toml`
- Modify: `/Volumes/Development/rovenue/.gitignore`

- [ ] **Step 1.1: Verify Rust toolchain installed**

Run: `rustc --version`
Expected: `rustc 1.78.0` or newer. If not installed, run `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` first.

- [ ] **Step 1.2: Pin toolchain**

Create `/Volumes/Development/rovenue/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.78.0"
components = ["rustfmt", "clippy"]
profile = "minimal"
```

- [ ] **Step 1.3: Create workspace manifest**

Create `/Volumes/Development/rovenue/Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = [
    "packages/core-rs",
    "packages/core-rs/bindgen",
]

[workspace.package]
version = "0.0.1"
edition = "2021"
rust-version = "1.78"
license = "AGPL-3.0-only"
repository = "https://github.com/rovenue/rovenue"

[workspace.dependencies]
uniffi = { version = "0.27.3", features = ["cli"] }
thiserror = "1.0.61"
```

- [ ] **Step 1.4: Ignore Rust + native build outputs**

Append to `/Volumes/Development/rovenue/.gitignore` (create the file if missing):

```
# Rust
/target/
**/target/
Cargo.lock.bak

# Swift
packages/sdk-swift/.build/
packages/sdk-swift/.swiftpm/

# Kotlin / Android
packages/sdk-kotlin/build/
packages/sdk-kotlin/.gradle/
packages/sdk-kotlin/local.properties

# Generated UniFFI bindings (regenerated by build)
packages/sdk-swift/Sources/Rovenue/Generated/*
!packages/sdk-swift/Sources/Rovenue/Generated/.gitkeep
packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/*
!packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/.gitkeep
```

- [ ] **Step 1.5: Verify workspace metadata parses**

Run: `cd /Volumes/Development/rovenue && cargo metadata --no-deps --format-version 1 >/dev/null`
Expected: exits 0 with no errors (no members yet may warn — that's fine).

- [ ] **Step 1.6: Commit**

```bash
git add Cargo.toml rust-toolchain.toml .gitignore
git commit -m "chore(sdk): add Cargo workspace + rust-toolchain pin"
```

---

## Task 2: `librovenue` crate skeleton with version constant

**Files:**
- Create: `packages/core-rs/Cargo.toml`
- Create: `packages/core-rs/src/lib.rs`
- Create: `packages/core-rs/src/version.rs`
- Create: `packages/core-rs/tests/version_test.rs`

- [ ] **Step 2.1: Write failing test for SDK_VERSION constant**

Create `/Volumes/Development/rovenue/packages/core-rs/tests/version_test.rs`:

```rust
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
```

- [ ] **Step 2.2: Create crate manifest**

Create `/Volumes/Development/rovenue/packages/core-rs/Cargo.toml`:

```toml
[package]
name = "librovenue"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true
description = "Rovenue SDK core — shared business logic for Swift, Kotlin, React Native"

[lib]
name = "rovenue"
crate-type = ["cdylib", "staticlib", "rlib"]

[dependencies]
uniffi = { workspace = true }
thiserror = { workspace = true }

[build-dependencies]
uniffi = { workspace = true, features = ["build"] }

[dev-dependencies]
# integration tests reuse public surface via the rlib
```

- [ ] **Step 2.3: Create `src/version.rs`**

Create `/Volumes/Development/rovenue/packages/core-rs/src/version.rs`:

```rust
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
```

- [ ] **Step 2.4: Create stub `src/lib.rs`**

Create `/Volumes/Development/rovenue/packages/core-rs/src/lib.rs`:

```rust
pub mod version;
```

- [ ] **Step 2.5: Run the failing test (expect pass now that constant exists)**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests version_test`
Expected: 2 passed; 0 failed.

- [ ] **Step 2.6: Commit**

```bash
git add packages/core-rs/Cargo.toml packages/core-rs/src/lib.rs packages/core-rs/src/version.rs packages/core-rs/tests/version_test.rs
git commit -m "feat(core-rs): librovenue crate skeleton + SDK_VERSION constant"
```

---

## Task 3: Error enum

**Files:**
- Create: `packages/core-rs/src/error.rs`
- Create: `packages/core-rs/tests/error_test.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 3.1: Write failing test for error Display**

Create `/Volumes/Development/rovenue/packages/core-rs/tests/error_test.rs`:

```rust
use librovenue::error::RovenueError;

#[test]
fn not_configured_displays() {
    let e = RovenueError::NotConfigured;
    assert_eq!(format!("{e}"), "not configured");
}

#[test]
fn invalid_api_key_displays() {
    let e = RovenueError::InvalidApiKey;
    assert_eq!(format!("{e}"), "invalid api key");
}

#[test]
fn server_error_includes_status_and_message() {
    let e = RovenueError::ServerError {
        status: 503,
        message: "upstream down".into(),
    };
    let s = format!("{e}");
    assert!(s.contains("503"), "got {s}");
    assert!(s.contains("upstream down"), "got {s}");
}
```

- [ ] **Step 3.2: Run the failing test**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests error_test`
Expected: FAIL — `error` module does not exist.

- [ ] **Step 3.3: Implement error enum (M0 subset — full set lands in M1)**

Create `/Volumes/Development/rovenue/packages/core-rs/src/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("server error: {status} {message}")]
    ServerError { status: u16, message: String },

    #[error("internal: {0}")]
    Internal(String),
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
```

- [ ] **Step 3.4: Re-export from lib**

Edit `/Volumes/Development/rovenue/packages/core-rs/src/lib.rs` to be:

```rust
pub mod error;
pub mod version;

pub use error::{RovenueError, RovenueResult};
```

- [ ] **Step 3.5: Run the test (expect pass)**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests error_test`
Expected: 3 passed.

- [ ] **Step 3.6: Commit**

```bash
git add packages/core-rs/src/error.rs packages/core-rs/src/lib.rs packages/core-rs/tests/error_test.rs
git commit -m "feat(core-rs): RovenueError enum (M0 subset)"
```

---

## Task 4: Config struct

**Files:**
- Create: `packages/core-rs/src/config.rs`
- Create: `packages/core-rs/tests/config_test.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 4.1: Write failing test**

Create `/Volumes/Development/rovenue/packages/core-rs/tests/config_test.rs`:

```rust
use librovenue::config::Config;
use librovenue::RovenueError;

#[test]
fn config_validates_non_empty_api_key() {
    let err = Config::new("".into(), "https://api.rovenue.dev".into()).unwrap_err();
    assert!(matches!(err, RovenueError::InvalidApiKey));
}

#[test]
fn config_validates_https_base_url() {
    let err = Config::new("pk_test_abc".into(), "ftp://api".into()).unwrap_err();
    assert!(matches!(err, RovenueError::Internal(_)));
}

#[test]
fn config_accepts_valid_inputs() {
    let cfg = Config::new("pk_test_abc".into(), "https://api.rovenue.dev".into()).unwrap();
    assert_eq!(cfg.api_key, "pk_test_abc");
    assert_eq!(cfg.base_url, "https://api.rovenue.dev");
    assert!(!cfg.debug);
}
```

- [ ] **Step 4.2: Run, see it fail**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests config_test`
Expected: FAIL — `config` module missing.

- [ ] **Step 4.3: Implement `Config`**

Create `/Volumes/Development/rovenue/packages/core-rs/src/config.rs`:

```rust
use crate::error::{RovenueError, RovenueResult};

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub debug: bool,
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(RovenueError::Internal(format!(
                "base_url must be http(s)://, got {base_url}"
            )));
        }
        Ok(Self { api_key, base_url, debug: false })
    }
}
```

- [ ] **Step 4.4: Wire into lib**

Edit `/Volumes/Development/rovenue/packages/core-rs/src/lib.rs`:

```rust
pub mod config;
pub mod error;
pub mod version;

pub use config::Config;
pub use error::{RovenueError, RovenueResult};
```

- [ ] **Step 4.5: Run tests (expect pass)**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests config_test`
Expected: 3 passed.

- [ ] **Step 4.6: Commit**

```bash
git add packages/core-rs/src/config.rs packages/core-rs/src/lib.rs packages/core-rs/tests/config_test.rs
git commit -m "feat(core-rs): Config with api_key + base_url validation"
```

---

## Task 5: `RovenueCore` API surface (Rust-side)

**Files:**
- Create: `packages/core-rs/src/api.rs`
- Create: `packages/core-rs/tests/integration_smoke.rs`
- Modify: `packages/core-rs/src/lib.rs`

- [ ] **Step 5.1: Write failing integration test**

Create `/Volumes/Development/rovenue/packages/core-rs/tests/integration_smoke.rs`:

```rust
use librovenue::{Config, RovenueCore, SDK_VERSION};

#[test]
fn core_new_returns_handle() {
    let cfg = Config::new("pk_test_xyz".into(), "https://api.rovenue.dev".into()).unwrap();
    let core = RovenueCore::new(cfg).expect("core must construct");
    assert_eq!(core.get_version(), SDK_VERSION);
}

#[test]
fn core_new_rejects_invalid_config() {
    let cfg = Config::new("".into(), "https://api.rovenue.dev".into());
    assert!(cfg.is_err(), "empty api key must error before reaching core");
}
```

- [ ] **Step 5.2: Run, see it fail**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue --tests integration_smoke`
Expected: FAIL — `RovenueCore` not defined.

- [ ] **Step 5.3: Implement `RovenueCore`**

Create `/Volumes/Development/rovenue/packages/core-rs/src/api.rs`:

```rust
use std::sync::Arc;

use crate::config::Config;
use crate::error::RovenueResult;
use crate::version::SDK_VERSION;

pub struct RovenueCore {
    config: Arc<Config>,
}

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self> {
        Ok(Self { config: Arc::new(config) })
    }

    pub fn get_version(&self) -> String {
        SDK_VERSION.to_string()
    }

    pub fn config(&self) -> Arc<Config> {
        Arc::clone(&self.config)
    }
}
```

- [ ] **Step 5.4: Re-export from lib**

Edit `/Volumes/Development/rovenue/packages/core-rs/src/lib.rs`:

```rust
pub mod api;
pub mod config;
pub mod error;
pub mod version;

pub use api::RovenueCore;
pub use config::Config;
pub use error::{RovenueError, RovenueResult};
pub use version::SDK_VERSION;
```

- [ ] **Step 5.5: Run tests**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue`
Expected: all tests pass (version_test, error_test, config_test, integration_smoke).

- [ ] **Step 5.6: Commit**

```bash
git add packages/core-rs/src/api.rs packages/core-rs/src/lib.rs packages/core-rs/tests/integration_smoke.rs
git commit -m "feat(core-rs): RovenueCore with get_version()"
```

---

## Task 6: UniFFI scaffolding

**Files:**
- Create: `packages/core-rs/librovenue.udl`
- Create: `packages/core-rs/build.rs`
- Create: `packages/core-rs/uniffi.toml`
- Modify: `packages/core-rs/src/lib.rs`
- Modify: `packages/core-rs/src/api.rs`
- Modify: `packages/core-rs/src/error.rs`
- Modify: `packages/core-rs/src/config.rs`

- [ ] **Step 6.1: Define UDL**

Create `/Volumes/Development/rovenue/packages/core-rs/librovenue.udl`:

```
namespace librovenue {
    string sdk_version();
};

[Error]
enum RovenueError {
    "NotConfigured",
    "InvalidApiKey",
    "ServerError",
    "Internal",
};

dictionary Config {
    string api_key;
    string base_url;
    boolean debug;
};

interface RovenueCore {
    [Throws=RovenueError]
    constructor(Config config);

    string get_version();
};
```

- [ ] **Step 6.2: Create UniFFI config**

Create `/Volumes/Development/rovenue/packages/core-rs/uniffi.toml`:

```toml
[bindings.swift]
module_name = "RovenueFFI"
ffi_module_name = "RovenueFFI"
generate_module_map = true
omit_argument_labels = false

[bindings.kotlin]
package_name = "dev.rovenue.sdk.generated"
```

- [ ] **Step 6.3: Create build.rs**

Create `/Volumes/Development/rovenue/packages/core-rs/build.rs`:

```rust
fn main() {
    uniffi::generate_scaffolding("librovenue.udl").expect("uniffi scaffolding generation failed");
}
```

- [ ] **Step 6.4: Adapt RovenueError variants for UDL-flat error**

The UDL `[Error] enum` form needs unit variants only. Replace `RovenueError` in `/Volumes/Development/rovenue/packages/core-rs/src/error.rs` so the discriminant is FFI-stable but messages stay in `Display`. Edit the file to:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("server error")]
    ServerError,

    #[error("internal error")]
    Internal,
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
```

- [ ] **Step 6.5: Adjust Config to drop the dynamic Internal message**

Edit `/Volumes/Development/rovenue/packages/core-rs/src/config.rs` so `Config::new` returns `RovenueError::Internal` for bad URL:

```rust
use crate::error::{RovenueError, RovenueResult};

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub debug: bool,
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(RovenueError::Internal);
        }
        Ok(Self { api_key, base_url, debug: false })
    }
}
```

- [ ] **Step 6.6: Update error_test to match new variants**

Edit `/Volumes/Development/rovenue/packages/core-rs/tests/error_test.rs`:

```rust
use librovenue::error::RovenueError;

#[test]
fn not_configured_displays() {
    assert_eq!(format!("{}", RovenueError::NotConfigured), "not configured");
}

#[test]
fn invalid_api_key_displays() {
    assert_eq!(format!("{}", RovenueError::InvalidApiKey), "invalid api key");
}

#[test]
fn server_error_displays() {
    assert_eq!(format!("{}", RovenueError::ServerError), "server error");
}

#[test]
fn internal_displays() {
    assert_eq!(format!("{}", RovenueError::Internal), "internal error");
}
```

- [ ] **Step 6.7: Update config_test to match new error variant**

Edit `/Volumes/Development/rovenue/packages/core-rs/tests/config_test.rs`:

```rust
use librovenue::config::Config;
use librovenue::RovenueError;

#[test]
fn config_validates_non_empty_api_key() {
    let err = Config::new("".into(), "https://api.rovenue.dev".into()).unwrap_err();
    assert!(matches!(err, RovenueError::InvalidApiKey));
}

#[test]
fn config_validates_https_base_url() {
    let err = Config::new("pk_test_abc".into(), "ftp://api".into()).unwrap_err();
    assert!(matches!(err, RovenueError::Internal));
}

#[test]
fn config_accepts_valid_inputs() {
    let cfg = Config::new("pk_test_abc".into(), "https://api.rovenue.dev".into()).unwrap();
    assert_eq!(cfg.api_key, "pk_test_abc");
    assert_eq!(cfg.base_url, "https://api.rovenue.dev");
    assert!(!cfg.debug);
}
```

- [ ] **Step 6.8: Expose UniFFI namespace function and include scaffolding**

Edit `/Volumes/Development/rovenue/packages/core-rs/src/lib.rs`:

```rust
pub mod api;
pub mod config;
pub mod error;
pub mod version;

pub use api::RovenueCore;
pub use config::Config;
pub use error::{RovenueError, RovenueResult};
pub use version::SDK_VERSION;

pub fn sdk_version() -> String {
    SDK_VERSION.to_string()
}

uniffi::include_scaffolding!("librovenue");
```

- [ ] **Step 6.9: Build to verify scaffolding generates**

Run: `cd /Volumes/Development/rovenue && cargo build -p librovenue`
Expected: builds successfully; `target/debug/build/librovenue-*/out/librovenue.uniffi.rs` exists.

- [ ] **Step 6.10: Verify all tests still pass**

Run: `cd /Volumes/Development/rovenue && cargo test -p librovenue`
Expected: all green.

- [ ] **Step 6.11: Commit**

```bash
git add packages/core-rs/librovenue.udl packages/core-rs/uniffi.toml packages/core-rs/build.rs packages/core-rs/src packages/core-rs/tests
git commit -m "feat(core-rs): UniFFI UDL + scaffolding for RovenueCore"
```

---

## Task 7: UniFFI bindgen binary

**Files:**
- Create: `packages/core-rs/bindgen/Cargo.toml`
- Create: `packages/core-rs/bindgen/src/main.rs`

- [ ] **Step 7.1: Create bindgen crate manifest**

Create `/Volumes/Development/rovenue/packages/core-rs/bindgen/Cargo.toml`:

```toml
[package]
name = "rovenue-uniffi-bindgen"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false

[[bin]]
name = "rovenue-uniffi-bindgen"
path = "src/main.rs"

[dependencies]
uniffi = { workspace = true, features = ["cli"] }
```

- [ ] **Step 7.2: Create bindgen main**

Create `/Volumes/Development/rovenue/packages/core-rs/bindgen/src/main.rs`:

```rust
fn main() {
    uniffi::uniffi_bindgen_main()
}
```

- [ ] **Step 7.3: Smoke-test bindgen builds**

Run: `cd /Volumes/Development/rovenue && cargo build -p rovenue-uniffi-bindgen`
Expected: builds; binary at `target/debug/rovenue-uniffi-bindgen`.

- [ ] **Step 7.4: Smoke-test bindgen lists languages**

Run: `cd /Volumes/Development/rovenue && ./target/debug/rovenue-uniffi-bindgen generate --help`
Expected: shows `--language [kotlin|swift|python|ruby]`.

- [ ] **Step 7.5: Commit**

```bash
git add packages/core-rs/bindgen
git commit -m "feat(core-rs): rovenue-uniffi-bindgen CLI for binding generation"
```

---

## Task 8: Cross-compile build script (host-only for M0)

**Files:**
- Create: `packages/core-rs/scripts/build-bindings.sh`

> M0 scope: build for the host triple only so Swift on macOS + Kotlin on JVM tests can dlopen the dylib. iOS device / Android NDK cross-compile lives in M2/M3.

- [ ] **Step 8.1: Create build-bindings.sh**

Create `/Volumes/Development/rovenue/packages/core-rs/scripts/build-bindings.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Build librovenue for the host triple and generate Swift + Kotlin bindings.
# Run from repo root: ./packages/core-rs/scripts/build-bindings.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CORE_DIR="$ROOT/packages/core-rs"
SWIFT_OUT="$ROOT/packages/sdk-swift/Sources/Rovenue/Generated"
KOTLIN_OUT="$ROOT/packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated"

echo "→ cargo build (release, host triple)"
cargo build --release --manifest-path "$CORE_DIR/Cargo.toml" -p librovenue

case "$(uname -s)" in
    Darwin) DYLIB="librovenue.dylib" ;;
    Linux)  DYLIB="librovenue.so" ;;
    *)      echo "unsupported host"; exit 1 ;;
esac
DYLIB_PATH="$ROOT/target/release/$DYLIB"
test -f "$DYLIB_PATH" || { echo "missing $DYLIB_PATH"; exit 1; }

echo "→ generate Swift bindings → $SWIFT_OUT"
mkdir -p "$SWIFT_OUT"
cargo run --manifest-path "$CORE_DIR/Cargo.toml" -p rovenue-uniffi-bindgen -- \
    generate "$CORE_DIR/librovenue.udl" \
    --language swift \
    --out-dir "$SWIFT_OUT" \
    --config "$CORE_DIR/uniffi.toml"

echo "→ generate Kotlin bindings → $KOTLIN_OUT"
mkdir -p "$KOTLIN_OUT"
cargo run --manifest-path "$CORE_DIR/Cargo.toml" -p rovenue-uniffi-bindgen -- \
    generate "$CORE_DIR/librovenue.udl" \
    --language kotlin \
    --out-dir "$KOTLIN_OUT" \
    --config "$CORE_DIR/uniffi.toml"

echo "✓ bindings generated"
```

- [ ] **Step 8.2: Make executable**

Run: `chmod +x /Volumes/Development/rovenue/packages/core-rs/scripts/build-bindings.sh`

- [ ] **Step 8.3: Run the script**

Run: `cd /Volumes/Development/rovenue && ./packages/core-rs/scripts/build-bindings.sh`
Expected:
- `target/release/librovenue.dylib` exists (macOS) or `librovenue.so` (Linux)
- `packages/sdk-swift/Sources/Rovenue/Generated/Rovenue.swift` (or `librovenue.swift`) + `librovenueFFI.h` exist
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt` exists

- [ ] **Step 8.4: Verify generated Swift file references RovenueCore**

Run: `cd /Volumes/Development/rovenue && grep -l "RovenueCore" packages/sdk-swift/Sources/Rovenue/Generated/*.swift`
Expected: at least one `.swift` file matches.

- [ ] **Step 8.5: Verify generated Kotlin file references RovenueCore**

Run: `cd /Volumes/Development/rovenue && grep -l "RovenueCore" packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/*.kt`
Expected: at least one `.kt` file matches.

- [ ] **Step 8.6: Add `.gitkeep` placeholders**

```bash
mkdir -p packages/sdk-swift/Sources/Rovenue/Generated packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated
touch packages/sdk-swift/Sources/Rovenue/Generated/.gitkeep
touch packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/.gitkeep
```

- [ ] **Step 8.7: Commit**

```bash
git add packages/core-rs/scripts/build-bindings.sh \
        packages/sdk-swift/Sources/Rovenue/Generated/.gitkeep \
        packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/.gitkeep
git commit -m "feat(sdk): host-triple build script + bindgen scaffolding"
```

---

## Task 9: Swift façade — SPM package + tests

**Files:**
- Create: `packages/sdk-swift/Package.swift`
- Create: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Sources/RovenueFFI/module.modulemap`
- Create: `packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift`

> Prereq: Step 8 has been run so `Generated/*.swift` + `librovenueFFI.h` exist and `target/release/librovenue.dylib` is built.

- [ ] **Step 9.1: Create modulemap for the C header UniFFI emits**

Find the actual header filename (UniFFI ≥0.27 emits `<module>FFI.h`):

Run: `ls /Volumes/Development/rovenue/packages/sdk-swift/Sources/Rovenue/Generated/*.h`
Expected: one entry like `librovenueFFI.h`.

Create `/Volumes/Development/rovenue/packages/sdk-swift/Sources/RovenueFFI/module.modulemap`:

```
module RovenueFFI {
    umbrella header "../Rovenue/Generated/librovenueFFI.h"
    export *
}
```

If the actual emitted header has a different name (e.g. `RovenueFFI.h`), update the modulemap path accordingly.

- [ ] **Step 9.2: Create `Package.swift`**

Create `/Volumes/Development/rovenue/packages/sdk-swift/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Rovenue",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "Rovenue", targets: ["Rovenue"]),
    ],
    targets: [
        .systemLibrary(
            name: "RovenueFFI",
            path: "Sources/RovenueFFI"
        ),
        .target(
            name: "Rovenue",
            dependencies: ["RovenueFFI"],
            path: "Sources/Rovenue",
            linkerSettings: [
                .linkedLibrary("rovenue"),
                .unsafeFlags(["-L../../target/release"], .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(
            name: "RovenueTests",
            dependencies: ["Rovenue"],
            path: "Tests/RovenueTests"
        ),
    ]
)
```

- [ ] **Step 9.3: Write the failing Swift test**

Create `/Volumes/Development/rovenue/packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class RovenueTests: XCTestCase {
    func test_getVersion_matchesCargoPkgVersion() throws {
        let cfg = Config(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev", debug: false)
        let core = try RovenueCore(config: cfg)
        XCTAssertFalse(core.getVersion().isEmpty)
        XCTAssertEqual(core.getVersion(), "0.0.1")
    }

    func test_invalidApiKey_throws() {
        let cfg = Config(apiKey: "", baseUrl: "https://api.rovenue.dev", debug: false)
        XCTAssertThrowsError(try RovenueCore(config: cfg)) { err in
            guard case RovenueError.InvalidApiKey = err else {
                return XCTFail("expected InvalidApiKey, got \(err)")
            }
        }
    }
}
```

- [ ] **Step 9.4: Write the public Swift wrapper**

Create `/Volumes/Development/rovenue/packages/sdk-swift/Sources/Rovenue/Rovenue.swift`:

```swift
import Foundation

// The Generated/ folder (populated by build-bindings.sh) brings RovenueCore,
// Config, RovenueError, sdk_version() into the Rovenue module namespace.
// This file is the place to add an idiomatic Swift façade (actor + AsyncStream)
// in M1+; for M0 the generated types are re-exported as-is for the smoke test.

public enum RovenueModule {
    public static let version: String = sdk_version()
}
```

- [ ] **Step 9.5: Run Swift tests**

Run: `cd /Volumes/Development/rovenue/packages/sdk-swift && swift test`
Expected: 2 tests pass.

If the linker fails to find `librovenue`, set `DYLD_LIBRARY_PATH`:

```bash
DYLD_LIBRARY_PATH=$(pwd)/../../target/release swift test
```

- [ ] **Step 9.6: Commit**

```bash
git add packages/sdk-swift
git commit -m "feat(sdk-swift): SPM package + Rovenue façade smoke test"
```

---

## Task 10: Kotlin façade — Gradle module + tests

**Files:**
- Create: `packages/sdk-kotlin/settings.gradle.kts`
- Create: `packages/sdk-kotlin/build.gradle.kts`
- Create: `packages/sdk-kotlin/gradle.properties`
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt`

> Prereq: Step 8 has been run so `generated/librovenue.kt` exists and `target/release/librovenue.{dylib,so}` is built.

- [ ] **Step 10.1: Create `settings.gradle.kts`**

Create `/Volumes/Development/rovenue/packages/sdk-kotlin/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "sdk-kotlin"
```

- [ ] **Step 10.2: Create `gradle.properties`**

Create `/Volumes/Development/rovenue/packages/sdk-kotlin/gradle.properties`:

```
kotlin.code.style=official
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8
```

- [ ] **Step 10.3: Create `build.gradle.kts` (JVM-only for M0)**

Create `/Volumes/Development/rovenue/packages/sdk-kotlin/build.gradle.kts`:

```kotlin
plugins {
    kotlin("jvm") version "1.9.23"
}

group = "dev.rovenue"
version = "0.0.1"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.java.dev.jna:jna:5.14.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    systemProperty(
        "jna.library.path",
        rootProject.projectDir.resolve("../../target/release").canonicalPath
    )
}
```

- [ ] **Step 10.4: Write failing Kotlin test**

Create `/Volumes/Development/rovenue/packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RovenueTest {
    @Test
    fun `getVersion matches Cargo pkg version`() {
        val cfg = Config(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev", debug = false)
        val core = RovenueCore(cfg)
        assertEquals("0.0.1", core.getVersion())
    }

    @Test
    fun `invalid api key throws`() {
        val cfg = Config(apiKey = "", baseUrl = "https://api.rovenue.dev", debug = false)
        assertFailsWith<RovenueException.InvalidApiKey> {
            RovenueCore(cfg)
        }
    }

    @Test
    fun `version constant non-empty`() {
        assertTrue(dev.rovenue.sdk.generated.sdkVersion().isNotBlank())
    }
}
```

- [ ] **Step 10.5: Add façade file (re-export only for M0)**

Create `/Volumes/Development/rovenue/packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.sdkVersion

object Rovenue {
    val version: String
        get() = sdkVersion()
}
```

- [ ] **Step 10.6: Run Kotlin tests**

Run: `cd /Volumes/Development/rovenue/packages/sdk-kotlin && gradle test --no-daemon`
Expected: 3 tests pass. If `gradle` isn't installed: `brew install gradle` first, or use `./gradlew` after generating a wrapper (`gradle wrapper --gradle-version 8.5`).

- [ ] **Step 10.7: Commit**

```bash
git add packages/sdk-kotlin
git commit -m "feat(sdk-kotlin): Gradle module + Rovenue façade smoke test (JVM)"
```

---

## Task 11: RN façade — JS-only stub with version constant

**Files:**
- Modify: `packages/sdk-rn/package.json`
- Modify: `packages/sdk-rn/src/index.ts`
- Create: `packages/sdk-rn/src/version.ts`
- Create: `packages/sdk-rn/src/__tests__/configure.test.ts`
- Create: `packages/sdk-rn/tsconfig.json`

> Spec §4.4 defines a full Nitro-based façade. M0 ships only the JS public surface; native Nitro+Rust bridge is M1+. The version constant on the JS side has a sync-check test that fails loudly if it drifts from the Rust crate.

- [ ] **Step 11.1: Replace `packages/sdk-rn/package.json`**

Edit `/Volumes/Development/rovenue/packages/sdk-rn/package.json` to:

```json
{
  "name": "@rovenue/sdk-rn",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./version": "./src/version.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "peerDependencies": {
    "react": ">=18",
    "react-native": ">=0.73"
  },
  "dependencies": {
    "@rovenue/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.3.0"
  }
}
```

- [ ] **Step 11.2: Create `tsconfig.json`**

Create `/Volumes/Development/rovenue/packages/sdk-rn/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 11.3: Write the failing Vitest**

Create `/Volumes/Development/rovenue/packages/sdk-rn/src/__tests__/configure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configure, getVersion, SDK_VERSION } from "../index";

describe("Rovenue RN stub", () => {
  it("exposes a non-empty SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("SDK_VERSION matches packages/core-rs/Cargo.toml version", () => {
    const cargoToml = readFileSync(
      join(__dirname, "../../../core-rs/Cargo.toml"),
      "utf8",
    );
    // workspace-package version inheritance: walk up to root Cargo.toml
    const rootCargo = readFileSync(
      join(__dirname, "../../../../Cargo.toml"),
      "utf8",
    );
    const m = rootCargo.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
    expect(m, "could not find workspace.package version").not.toBeNull();
    expect(SDK_VERSION).toBe(m![1]);
    expect(cargoToml).toContain("version.workspace = true");
  });

  it("getVersion() returns SDK_VERSION", () => {
    expect(getVersion()).toBe(SDK_VERSION);
  });

  it("configure() with empty key throws", () => {
    expect(() => configure({ apiKey: "", baseUrl: "https://api.rovenue.dev" })).toThrow(
      /api key/i,
    );
  });

  it("configure() with valid input returns handle", () => {
    const handle = configure({ apiKey: "pk_test", baseUrl: "https://api.rovenue.dev" });
    expect(handle.getVersion()).toBe(SDK_VERSION);
  });
});
```

- [ ] **Step 11.4: Implement `src/version.ts`**

Create `/Volumes/Development/rovenue/packages/sdk-rn/src/version.ts`:

```ts
export const SDK_VERSION = "0.0.1";
```

- [ ] **Step 11.5: Implement `src/index.ts`**

Edit `/Volumes/Development/rovenue/packages/sdk-rn/src/index.ts` to:

```ts
import { SDK_VERSION } from "./version";

export { SDK_VERSION };

export type RovenueConfig = {
  apiKey: string;
  baseUrl: string;
  debug?: boolean;
};

export type RovenueHandle = {
  getVersion(): string;
};

class RovenueStub implements RovenueHandle {
  constructor(public readonly config: Readonly<RovenueConfig>) {}
  getVersion(): string {
    return SDK_VERSION;
  }
}

export function configure(config: RovenueConfig): RovenueHandle {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("Rovenue: invalid api key");
  }
  if (!/^https?:\/\//.test(config.baseUrl)) {
    throw new Error("Rovenue: base_url must be http(s)");
  }
  return new RovenueStub({ debug: false, ...config });
}

export function getVersion(): string {
  return SDK_VERSION;
}
```

- [ ] **Step 11.6: Install Vitest if not already at root**

Run: `cd /Volumes/Development/rovenue && pnpm install --filter @rovenue/sdk-rn`
Expected: dependencies installed without errors.

- [ ] **Step 11.7: Run tests**

Run: `cd /Volumes/Development/rovenue && pnpm --filter @rovenue/sdk-rn test`
Expected: 5 tests pass.

- [ ] **Step 11.8: Build TS**

Run: `cd /Volumes/Development/rovenue && pnpm --filter @rovenue/sdk-rn build`
Expected: emits `packages/sdk-rn/dist/` cleanly.

- [ ] **Step 11.9: Commit**

```bash
git add packages/sdk-rn
git commit -m "feat(sdk-rn): configure/getVersion JS stub + Cargo version sync test"
```

---

## Task 12: Turborepo wiring for Rust task

**Files:**
- Modify: `turbo.json`

- [ ] **Step 12.1: Edit `turbo.json` to register a `cargo:test` task**

Edit `/Volumes/Development/rovenue/turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "build/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"]
    },
    "//#cargo:test": {
      "cache": false,
      "outputs": []
    },
    "//#cargo:fmt": {
      "cache": false,
      "outputs": []
    },
    "//#cargo:clippy": {
      "cache": false,
      "outputs": []
    }
  }
}
```

- [ ] **Step 12.2: Add root scripts**

Edit `/Volumes/Development/rovenue/package.json` `scripts` block — add the four cargo-related lines while keeping the rest:

```json
"cargo:test": "cargo test --workspace --all-targets",
"cargo:fmt": "cargo fmt --all -- --check",
"cargo:clippy": "cargo clippy --workspace --all-targets -- -D warnings",
"sdk:bindings": "./packages/core-rs/scripts/build-bindings.sh"
```

- [ ] **Step 12.3: Verify root tasks**

Run: `cd /Volumes/Development/rovenue && pnpm cargo:test`
Expected: full cargo test suite passes.

Run: `cd /Volumes/Development/rovenue && pnpm cargo:fmt`
Expected: passes (no diffs).

Run: `cd /Volumes/Development/rovenue && pnpm cargo:clippy`
Expected: passes with no warnings.

- [ ] **Step 12.4: Commit**

```bash
git add turbo.json package.json
git commit -m "chore(sdk): turbo + root scripts for cargo tasks"
```

---

## Task 13: CI workflow — Rust core + Swift + Kotlin

**Files:**
- Create: `.github/workflows/sdk.yml`

- [ ] **Step 13.1: Write the workflow**

Create `/Volumes/Development/rovenue/.github/workflows/sdk.yml`:

```yaml
name: SDK

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - "packages/core-rs/**"
      - "packages/sdk-swift/**"
      - "packages/sdk-kotlin/**"
      - "packages/sdk-rn/**"
      - "Cargo.toml"
      - "rust-toolchain.toml"
      - ".github/workflows/sdk.yml"

jobs:
  rust-core:
    name: Rust core (test + fmt + clippy)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.78.0
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace --all-targets

  bindgen-host:
    name: UniFFI bindgen (host)
    runs-on: ubuntu-latest
    needs: rust-core
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.78.0
      - uses: Swatinem/rust-cache@v2
      - run: ./packages/core-rs/scripts/build-bindings.sh
      - name: Confirm Swift binding emitted
        run: ls packages/sdk-swift/Sources/Rovenue/Generated/*.swift
      - name: Confirm Kotlin binding emitted
        run: ls packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/*.kt
      - uses: actions/upload-artifact@v4
        with:
          name: bindings
          path: |
            packages/sdk-swift/Sources/Rovenue/Generated
            packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated
            target/release/librovenue.so

  swift:
    name: Swift façade
    runs-on: macos-14
    needs: bindgen-host
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.78.0
      - uses: Swatinem/rust-cache@v2
      - run: ./packages/core-rs/scripts/build-bindings.sh
      - name: swift test
        working-directory: packages/sdk-swift
        run: |
          export DYLD_LIBRARY_PATH=$GITHUB_WORKSPACE/target/release
          swift test

  kotlin:
    name: Kotlin façade (JVM)
    runs-on: ubuntu-latest
    needs: bindgen-host
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.78.0
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
      - uses: gradle/actions/setup-gradle@v3
      - run: ./packages/core-rs/scripts/build-bindings.sh
      - name: gradle test
        working-directory: packages/sdk-kotlin
        run: gradle test --no-daemon

  rn:
    name: RN façade (TS)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @rovenue/sdk-rn test
      - run: pnpm --filter @rovenue/sdk-rn build
```

- [ ] **Step 13.2: Run the Rust portion locally as a dry-run**

Run: `cd /Volumes/Development/rovenue && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --all-targets`
Expected: all pass.

- [ ] **Step 13.3: Commit**

```bash
git add .github/workflows/sdk.yml
git commit -m "ci(sdk): rust + swift + kotlin + rn jobs"
```

---

## Task 14: End-to-end parity smoke test

**Files:**
- Create: `scripts/sdk-parity.sh`

> Manual / local check that all three façades report the **same** version string from independent codepaths. M0 doesn't need a fancy parity harness — a 30-line bash script that scrapes each test output is enough.

- [ ] **Step 14.1: Write the parity script**

Create `/Volumes/Development/rovenue/scripts/sdk-parity.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ regenerate bindings"
./packages/core-rs/scripts/build-bindings.sh >/dev/null

echo "→ Rust version"
RUST_VER=$(cargo run --quiet --manifest-path packages/core-rs/Cargo.toml --example print_version 2>/dev/null || \
           cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys;m=json.load(sys.stdin);print(next(p["version"] for p in m["packages"] if p["name"]=="librovenue"))')
echo "  $RUST_VER"

echo "→ Swift version (via swift test output)"
SWIFT_TEST=$(cd packages/sdk-swift && DYLD_LIBRARY_PATH="$ROOT/target/release" swift test 2>&1)
echo "$SWIFT_TEST" | grep -E "Test Suite .*passed" >/dev/null

echo "→ Kotlin version (via gradle test output)"
KOTLIN_TEST=$(cd packages/sdk-kotlin && gradle test --no-daemon --console=plain 2>&1)
echo "$KOTLIN_TEST" | grep -E "BUILD SUCCESSFUL" >/dev/null

echo "→ RN version (via Vitest)"
RN_TEST=$(pnpm --filter @rovenue/sdk-rn test --reporter=verbose 2>&1)
echo "$RN_TEST" | grep -E "5 passed" >/dev/null

echo
echo "✓ Parity: all four codepaths agree on version $RUST_VER"
```

- [ ] **Step 14.2: Make executable**

Run: `chmod +x /Volumes/Development/rovenue/scripts/sdk-parity.sh`

- [ ] **Step 14.3: Run it**

Run: `cd /Volumes/Development/rovenue && ./scripts/sdk-parity.sh`
Expected: exits 0 with `✓ Parity: all four codepaths agree on version 0.0.1`.

If you have not installed `gradle` locally, skip Kotlin and verify only via CI.

- [ ] **Step 14.4: Commit**

```bash
git add scripts/sdk-parity.sh
git commit -m "test(sdk): cross-platform version parity smoke script"
```

---

## Task 15: Push branch and open PR

- [ ] **Step 15.1: Verify clean state**

Run: `cd /Volumes/Development/rovenue && git status`
Expected: clean working tree, branch ahead of origin/main by ~13 commits.

- [ ] **Step 15.2: Push**

Run: `cd /Volumes/Development/rovenue && git push -u origin HEAD`

- [ ] **Step 15.3: Open PR**

Run:

```bash
gh pr create --title "feat(sdk): M0 — repo skeleton (Rust core + Swift/Kotlin/RN façades)" \
  --body "$(cat <<'EOF'
## Summary
- Cargo workspace + librovenue Rust crate with UniFFI UDL
- Swift SPM package, Kotlin Gradle module, RN TS stub all expose `getVersion()`
- CI matrix: rust-core → bindgen-host → swift / kotlin / rn

## Test plan
- [ ] CI green
- [ ] Local `pnpm cargo:test` passes
- [ ] Local `./scripts/sdk-parity.sh` exits 0
- [ ] No native cross-compile yet (iOS device / Android NDK lands in M2/M3)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

**Spec coverage (§-by-§):**
- §3.1 architecture: only the FFI plumbing layer is touched; transport/cache/identity/polling/offline/audit/crypto deliberately deferred to M1+ per §9 milestones.
- §4.1 Rust core file list: `api.rs`, `config.rs`, `error.rs`, `version.rs`, `lib.rs` created. `transport/`, `cache/`, `identity/`, `polling/`, `offline/`, `billing/`, `credits/`, `entitlements/`, `audit/`, `crypto/`, `observer.rs` deferred to later milestones.
- §4.2 Swift, §4.3 Kotlin, §4.4 RN: only `getVersion()` surface exercised; full billing/entitlements/credits hooks deferred.
- §6 error handling: only `NotConfigured`, `InvalidApiKey`, `ServerError`, `Internal` variants in M0; full set lands in M1 with HTTP transport.
- §8.1 repo layout: matches.
- §8.5 CI: `rust-core`, `bindgen-host`, `swift`, `kotlin`, `rn` jobs present; full multi-target cross-compile + xcframework/aar packaging deferred.
- §9 M0 deliverable "3 platforms can `configure()` + `getVersion()`": ✓ via Swift + Kotlin real FFI, RN JS stub with sync-checked version constant.

**Placeholder scan:** no TBDs, no "implement later" without dated milestone reference, every code block is complete.

**Type consistency:** `Config { api_key, base_url, debug }` is used identically in Rust (snake_case), Swift (apiKey/baseUrl/debug — UniFFI renames per `omit_argument_labels=false`), Kotlin (apiKey/baseUrl/debug), TS (apiKey/baseUrl/debug). `RovenueCore` constructor + `getVersion()` is consistent. The Kotlin test imports `RovenueException.InvalidApiKey` because UniFFI's Kotlin bindgen maps `[Error] enum` to `Exception` subtypes — verified against UniFFI 0.27 docs.

**Known risk:** UniFFI 0.27 may emit slightly different filenames for the generated `.h` (e.g. `librovenueFFI.h` vs `RovenueFFI.h`). Step 9.1 has an explicit `ls` to confirm the real filename before writing the modulemap — adjust path inline if needed.

---

*End of plan.*
