# SDK Optional `baseUrl` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `baseUrl` optional across all Rovenue SDK surfaces, falling back to the hosted endpoint `https://api.rovenue.io` while letting self-hosters override it.

**Architecture:** The default and validation live once in the Rust core. The UniFFI `Config` dictionary gets a UDL default for `base_url`; `RovenueCore::new` normalizes + validates the URL (the FFI path bypasses `Config::new`, so validation must run there to take effect). The three façades (RN/TS, Swift, Kotlin) make `baseUrl` an optional parameter and omit it when absent so the core default applies.

**Tech Stack:** Rust (UniFFI), Swift (XCTest), Kotlin (JUnit5 / `testDebugUnitTest`), TypeScript (Vitest), Expo Modules bridge.

**Key constraint:** Request paths already carry `/v1/` (e.g. `/v1/offerings`) and the core builds URLs as `base_url + path` (`packages/core-rs/src/transport/http_client.rs:62`). The default is therefore **origin-only** (`https://api.rovenue.io`); appending `/v1` would yield `/v1/v1/...`.

---

### Task 1: Rust core — default + validation

**Files:**
- Modify: `packages/core-rs/src/config.rs`
- Modify: `packages/core-rs/src/api.rs:48-54` (`RovenueCore::new`)
- Modify: `packages/core-rs/src/librovenue.udl:23-28` (`Config` dictionary)
- Test: `packages/core-rs/tests/config_test.rs`

- [ ] **Step 1: Replace the existing core config tests with the new behavior**

Overwrite `packages/core-rs/tests/config_test.rs` with:

```rust
use rovenue::config::{resolve_base_url, Config, DEFAULT_BASE_URL};
use rovenue::RovenueError;

#[test]
fn config_validates_non_empty_api_key() {
    let err = Config::new("".into(), "https://api.rovenue.io".into()).unwrap_err();
    assert!(matches!(err, RovenueError::InvalidApiKey));
}

#[test]
fn blank_base_url_falls_back_to_default() {
    assert_eq!(resolve_base_url("").unwrap(), DEFAULT_BASE_URL);
    assert_eq!(resolve_base_url("   ").unwrap(), DEFAULT_BASE_URL);
    let cfg = Config::new("pk_test_abc".into(), "".into()).unwrap();
    assert_eq!(cfg.base_url, "https://api.rovenue.io");
}

#[test]
fn https_base_url_is_accepted() {
    assert_eq!(
        resolve_base_url("https://self.hosted.example.com").unwrap(),
        "https://self.hosted.example.com"
    );
}

#[test]
fn plain_http_base_url_is_rejected() {
    let err = resolve_base_url("http://self.hosted.example.com").unwrap_err();
    assert!(matches!(err, RovenueError::InvalidArgument));
}

#[test]
fn non_http_scheme_is_rejected() {
    let err = resolve_base_url("ftp://api").unwrap_err();
    assert!(matches!(err, RovenueError::InvalidArgument));
}

#[test]
fn http_localhost_is_allowed() {
    assert!(resolve_base_url("http://localhost:3000").is_ok());
    assert!(resolve_base_url("http://127.0.0.1:3000/v1").is_ok());
    assert!(resolve_base_url("http://[::1]:3000").is_ok());
    // guard against prefix-spoofing
    assert!(resolve_base_url("http://localhostevil.com").is_err());
}

#[test]
fn config_accepts_valid_inputs() {
    let cfg = Config::new("pk_test_abc".into(), "https://api.rovenue.io".into()).unwrap();
    assert_eq!(cfg.api_key, "pk_test_abc");
    assert_eq!(cfg.base_url, "https://api.rovenue.io");
    assert!(!cfg.debug);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p rovenue --test config_test`
Expected: FAIL — `resolve_base_url` and `DEFAULT_BASE_URL` are not defined; `InvalidArgument`/blank-fallback assertions fail.

- [ ] **Step 3: Implement the default + validation in `config.rs`**

Replace the full contents of `packages/core-rs/src/config.rs` with:

```rust
use crate::error::{RovenueError, RovenueResult};

/// Canonical hosted endpoint used when the caller does not supply a base URL.
/// MUST stay in sync with the `base_url` default literal in `librovenue.udl`.
pub const DEFAULT_BASE_URL: &str = "https://api.rovenue.io";

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub debug: bool,
    /// Host app's user-facing version string (CFBundleShortVersionString on iOS,
    /// PackageInfo.versionName on Android). Forwarded into session-event
    /// telemetry payloads. `None` is serialized as `""` to preserve the
    /// pre-0.7 wire format.
    pub app_version: Option<String>,
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        Ok(Self {
            api_key,
            base_url: resolve_base_url(&base_url)?,
            debug: false,
            app_version: None,
        })
    }

    /// Builder-style setter for the host app version.
    pub fn with_app_version(mut self, app_version: Option<String>) -> Self {
        self.app_version = app_version;
        self
    }

    /// Normalize + validate a `Config` built directly from the UniFFI
    /// dictionary. The FFI path constructs the struct field-by-field and
    /// bypasses `new`, so this is where the base-URL rules get enforced over
    /// the FFI boundary. Empty `base_url` falls back to the hosted default.
    pub fn normalized(mut self) -> RovenueResult<Self> {
        self.base_url = resolve_base_url(&self.base_url)?;
        Ok(self)
    }
}

/// Resolve a caller-supplied base URL:
/// - blank (after trim) → [`DEFAULT_BASE_URL`]
/// - `https://…` accepted
/// - `http://…` accepted ONLY for localhost / 127.0.0.1 / [::1] (local dev)
/// - anything else → [`RovenueError::InvalidArgument`]
pub fn resolve_base_url(input: &str) -> RovenueResult<String> {
    let trimmed = input.trim();
    let url = if trimmed.is_empty() { DEFAULT_BASE_URL } else { trimmed };

    if let Some(rest) = url.strip_prefix("https://") {
        if rest.is_empty() {
            return Err(RovenueError::InvalidArgument);
        }
        return Ok(url.to_string());
    }

    if let Some(host) = url.strip_prefix("http://") {
        let is_local = host == "localhost"
            || host.starts_with("localhost:")
            || host.starts_with("localhost/")
            || host.starts_with("127.0.0.1")
            || host.starts_with("[::1]");
        if is_local {
            return Ok(url.to_string());
        }
        return Err(RovenueError::InvalidArgument);
    }

    Err(RovenueError::InvalidArgument)
}
```

- [ ] **Step 4: Wire validation into the FFI constructor `RovenueCore::new`**

In `packages/core-rs/src/api.rs`, change `new` (lines 48-54) so the base URL is normalized/validated **before** the cache store opens (early-return on a bad URL, no side effects):

```rust
    pub fn new(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let config = config.normalized()?;
        let store = Arc::new(CacheStore::open(&default_db_path()?)?);
        Self::from_store(config, store)
    }
```

- [ ] **Step 5: Add the UDL default for `base_url`**

In `packages/core-rs/src/librovenue.udl`, change the `Config` dictionary (lines 23-28) so the only defaulted field is last (avoids UniFFI's "defaults must be trailing" constraint; UniFFI matches struct fields by name, so the Rust struct field order is unchanged):

```
dictionary Config {
    string api_key;
    boolean debug;
    string? app_version;
    string base_url = "https://api.rovenue.io";
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p rovenue --test config_test`
Expected: PASS (7 tests).

Also run the full core suite to confirm no regression in the transport/URL code:
Run: `cargo test -p rovenue`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/config.rs packages/core-rs/src/api.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/config_test.rs
git commit -m "feat(sdk-core): optional base_url with api.rovenue.io default + https validation"
```

---

### Task 2: Regenerate UniFFI bindings

**Files:**
- Regenerated (gitignored build artifacts): `packages/sdk-swift/.../Config` + `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt`

- [ ] **Step 1: Regenerate bindings from the updated UDL**

Run: `npm run sdk:bindings`
Expected: Swift + Kotlin bindings regenerate with no errors. The generated `Config` now has `baseUrl` with a default of `"https://api.rovenue.io"`.

- [ ] **Step 2: Verify the generated `Config` carries the default**

Run: `grep -n "baseUrl" packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt`
Expected: a `Config` data-class field `var baseUrl: kotlin.String = "https://api.rovenue.io"` (default present).

If `npm run sdk:bindings` errors on the UDL default ordering, the field is already trailing in the dictionary (Task 1 Step 5); re-read the generator error and adjust only the UDL field order — do not hardcode the default elsewhere.

- [ ] **Step 3: No commit**

Generated bindings are gitignored build artifacts (per project convention) — nothing to commit here. Proceed to the façade tasks.

---

### Task 3: Swift façade — optional `baseUrl`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift:59-75`
- Test: `packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift`

- [ ] **Step 1: Add a failing test for the omitted-`baseUrl` path**

Append to `packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift`, inside the `ConfigurationTests` class (before the closing brace):

```swift
    func test_configure_succeedsWithoutBaseUrl() throws {
        // baseUrl omitted → core falls back to the hosted default.
        try Rovenue.configure(apiKey: "pk_test_default")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --package-path packages/sdk-swift --filter ConfigurationTests/test_configure_succeedsWithoutBaseUrl`
Expected: FAIL to compile — `configure` requires a `baseUrl:` argument.

- [ ] **Step 3: Make `baseUrl` optional in the façade**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, change the `configure` signature and `Config` construction (lines 59-75):

```swift
    public static func configure(
        apiKey: String,
        baseUrl: String? = nil,
        debug: Bool = false,
        appVersion: String? = nil
    ) throws {
        emit(LogEntry(level: "info", message: "configure"))
        guard !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw Rovenue.Error.invalidApiKey
        }
        let resolvedVersion = appVersion ?? readBundleAppVersion()
        // Omit baseUrl → the generated Config default ("https://api.rovenue.io")
        // applies; the Rust core validates it on construction.
        var config = Config(
            apiKey: apiKey,
            debug: debug,
            appVersion: resolvedVersion
        )
        if let baseUrl {
            config.baseUrl = baseUrl
        }
        let core: RovenueCore
        do {
            core = try RovenueCore(config: config)
        } catch let err as RovenueError {
            throw mapError(err)
        }
        let bridge = ObserverBridge()
        core.registerObserver(obs: bridge)
        let instance = Rovenue(core: core, bridge: bridge, appVersion: resolvedVersion)
        lock.lock()
        defer { lock.unlock() }
        _shared = instance
    }
```

- [ ] **Step 4: Run the Swift config tests to verify they pass**

Run: `swift test --package-path packages/sdk-swift --filter ConfigurationTests`
Expected: PASS (all 5 tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift
git commit -m "feat(sdk-swift): make baseUrl optional in configure()"
```

---

### Task 4: Kotlin façade — optional `baseUrl`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt:108-125`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt`

- [ ] **Step 1: Add a failing test for the omitted-`baseUrl` path**

Append to `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt`, inside the `ConfigurationTest` class (before the closing brace):

```kotlin
    @Test
    fun `configure succeeds without base url`() {
        // baseUrl omitted → core falls back to the hosted default.
        Rovenue.configure(apiKey = "pk_test_default")
        assertNotNull(Rovenue.shared)
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew -p packages/sdk-kotlin testDebugUnitTest --tests "dev.rovenue.sdk.ConfigurationTest"`
Expected: FAIL to compile — `configure` requires a `baseUrl` argument.

- [ ] **Step 3: Make `baseUrl` optional in the façade**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, change the `configure` signature and `Config` construction (lines 108-125):

```kotlin
        @Throws(RovenueException::class)
        fun configure(
            apiKey: String,
            baseUrl: String? = null,
            debug: Boolean = false,
            appVersion: String? = null,
            context: Context? = null,
        ) {
            emit(LogEntry(level = "info", message = "configure"))
            if (apiKey.isBlank()) {
                throw RovenueException.InvalidApiKey("apiKey is blank")
            }
            // Omit baseUrl → the generated Config default ("https://api.rovenue.io")
            // applies; the Rust core validates it on construction.
            val config = Config(
                apiKey = apiKey,
                debug = debug,
                appVersion = appVersion,
            ).let { if (baseUrl != null) it.copy(baseUrl = baseUrl) else it }
            val core = RovenueCore(config)  // may throw RovenueException
```

(Leave the rest of the method body — from `val bridge = ObserverBridge()` onward — unchanged.)

- [ ] **Step 4: Run the Kotlin config tests to verify they pass**

Run: `./gradlew -p packages/sdk-kotlin testDebugUnitTest --tests "dev.rovenue.sdk.ConfigurationTest"`
Expected: PASS (all 5 tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt
git commit -m "feat(sdk-kotlin): make baseUrl optional in configure()"
```

---

### Task 5: React Native — optional `baseUrl` (JS + native bridges)

**Files:**
- Modify: `packages/sdk-rn/src/api/configure.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts:64-69`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift:55-62`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt:55-65`
- Test: `packages/sdk-rn/src/__tests__/api.test.ts`

- [ ] **Step 1: Update the existing RN configure tests for optional `baseUrl`**

In `packages/sdk-rn/src/__tests__/api.test.ts`, replace the `configure rejects non-http baseUrl` test (lines 41-44) and add an omitted-baseUrl case. Replace lines 41-44 with:

```ts
  it("configure rejects malformed baseUrl when provided", () => {
    expect(() => configure({ apiKey: "pk_test", baseUrl: "not-a-url" }))
      .toThrow(/baseUrl/);
  });

  it("configure omits baseUrl when not provided", () => {
    configure({ apiKey: "pk_test" });
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      undefined,
      false,
      undefined,
    );
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `pnpm --filter @rovenue/sdk-rn test -- api.test.ts`
Expected: FAIL — `RovenueConfig` requires `baseUrl`, so `configure({ apiKey: "pk_test" })` is a type/call error and `native.configure` is not called with `undefined` in the baseUrl slot.

- [ ] **Step 3: Make `baseUrl` optional in the JS façade**

Replace the contents of `packages/sdk-rn/src/api/configure.ts` with:

```ts
import { startEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { InvalidApiKeyError } from "../errors";
import { startSessionTracker } from "./sessionTracker";

export type RovenueConfig = {
  apiKey: string;
  /**
   * API host. Optional — defaults to the hosted endpoint
   * `https://api.rovenue.io`. Self-hosters pass their own origin
   * (e.g. `https://api.acme.com`). The Rust core enforces https://
   * (http:// is accepted only for localhost during local dev).
   */
  baseUrl?: string;
  debug?: boolean;
  /**
   * Optional override for the host app's user-facing version. When
   * omitted, the native modules auto-read the value:
   *   - iOS: `Bundle.main.infoDictionary["CFBundleShortVersionString"]`
   *   - Android: `packageManager.getPackageInfo(packageName, 0).versionName`
   * For Expo apps the auto-read value is baked from `app.json`'s
   * `expo.version` at prebuild time, so most callers should leave this
   * undefined.
   */
  appVersion?: string;
};

export function configure(opts: RovenueConfig): void {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new InvalidApiKeyError("apiKey is blank");
  }
  if (opts.baseUrl !== undefined && !/^https?:\/\//.test(opts.baseUrl)) {
    throw new InvalidApiKeyError("baseUrl must start with http:// or https://");
  }
  const native = getNative();
  native.configure(
    opts.apiKey,
    opts.baseUrl,
    opts.debug ?? false,
    opts.appVersion,
  );
  startEventBridge();
  startSessionTracker();
}
```

- [ ] **Step 4: Make `baseUrl` optional in the native bridge spec**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`, change the `configure` signature (lines 64-69):

```ts
  configure(
    apiKey: string,
    baseUrl: string | undefined,
    debug: boolean,
    appVersion?: string,
  ): void;
```

- [ ] **Step 5: Make `baseUrl` optional in the iOS bridge**

In `packages/sdk-rn/ios/RovenueModule.swift`, change the `Function("configure")` block (lines 55-62):

```swift
        Function("configure") { (apiKey: String, baseUrl: String?, debug: Bool, appVersion: String?) in
            try Rovenue.configure(
                apiKey: apiKey,
                baseUrl: baseUrl,
                debug: debug,
                appVersion: appVersion
            )
        }
```

- [ ] **Step 6: Make `baseUrl` optional in the Android bridge**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, change the `Function("configure")` block (lines 55-65):

```kotlin
        Function("configure") { apiKey: String, baseUrl: String?, debug: Boolean, appVersion: String? ->
            val resolved = appVersion ?: readPackageVersionName()
            // The M4 Kotlin façade needs a Context to drive Play Billing.
            Rovenue.configure(
                apiKey = apiKey,
                baseUrl = baseUrl,
                debug = debug,
                appVersion = resolved,
                context = appContext.reactContext?.applicationContext,
            )
        }
```

- [ ] **Step 7: Run the RN tests to verify they pass**

Run: `pnpm --filter @rovenue/sdk-rn test -- api.test.ts`
Expected: PASS (including `configure omits baseUrl when not provided`).

Then run the type check:
Run: `pnpm --filter @rovenue/sdk-rn build`
Expected: PASS — no TS errors from the optional `baseUrl`.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-rn/src/api/configure.ts packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/ios/RovenueModule.swift packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt packages/sdk-rn/src/__tests__/api.test.ts
git commit -m "feat(sdk-rn): make baseUrl optional in configure()"
```

---

### Task 6: Docs + example app

**Files:**
- Modify: `examples/sample-rn-expo/App.tsx`
- Modify: `apps/docs` configure snippets (RN/Swift/Kotlin)

- [ ] **Step 1: Locate the configure snippets in docs**

Run: `grep -rn "baseUrl\|base_url\|configure(" apps/docs --include="*.md" --include="*.mdx"`
Expected: a list of doc files containing `configure(...)` examples that pass `baseUrl`.

- [ ] **Step 2: Update the example app to use the hosted default**

In `examples/sample-rn-expo/App.tsx`, remove the explicit `baseUrl` from the `configure({ ... })` call so it demonstrates the hosted default. (This file is already modified in the working tree — fold this change into it.) After editing, the call should read approximately:

```tsx
    Rovenue.configure({ apiKey: "pk_test_..." });
```

Keep whatever `apiKey` constant the file already uses; only drop the `baseUrl` line.

- [ ] **Step 3: Update each docs configure snippet**

For every snippet found in Step 1, make `baseUrl` optional in the prose and show both forms. Use this pattern (adapt per language block already present):

````markdown
Using the hosted Rovenue service, `baseUrl` is optional:

```ts
Rovenue.configure({ apiKey: "pk_live_..." });
```

Self-hosting? Point the SDK at your own deployment:

```ts
Rovenue.configure({ apiKey: "pk_live_...", baseUrl: "https://api.acme.com" });
```

The host must use `https://` (plain `http://` is accepted only for `localhost` during local development).
````

Apply the equivalent edit to the Swift (`Rovenue.configure(apiKey:)` vs `apiKey:baseUrl:`) and Kotlin (`Rovenue.configure(apiKey = ...)`) snippets.

- [ ] **Step 4: Verify docs build**

Run: `pnpm --filter @rovenue/docs build`
Expected: PASS (no broken MDX / snippet compilation).

- [ ] **Step 5: Commit**

```bash
git add examples/sample-rn-expo/App.tsx apps/docs
git commit -m "docs(sdk): baseUrl is optional; document self-hosting override"
```

---

## Self-Review

**Spec coverage:**
- Core single-source default + UDL default → Task 1 (Steps 3, 5).
- Origin-only default (versioning in path) → Task 1 Step 3 (`DEFAULT_BASE_URL`), enforced by tests.
- https-only-except-localhost validation + `InvalidArgument` → Task 1 Steps 1, 3.
- Validation runs over FFI (not just `Config::new`) → Task 1 Step 4 (`RovenueCore::new` calls `normalized()`).
- RN/TS optional `baseUrl` + native bridges optional → Task 5.
- Swift optional → Task 3. Kotlin optional → Task 4.
- Bindings regeneration → Task 2.
- Example app + docs → Task 6.
All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Doc snippet step (Task 6 Step 3) gives a concrete pattern to apply per existing block — acceptable since the exact set of doc files is discovered in Step 1 and the content to write is fully specified.

**Type/name consistency:** `resolve_base_url`, `DEFAULT_BASE_URL`, and `Config::normalized` are defined in Task 1 and referenced consistently in the tests and `RovenueCore::new`. Façade param name `baseUrl` and generated field `baseUrl` are consistent across Tasks 2-5. The generated Kotlin `Config.copy(baseUrl = …)` and Swift `config.baseUrl = …` both rely on the UDL default added in Task 1 Step 5 and regenerated in Task 2.
