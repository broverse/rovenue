import Foundation
import XCTest

/// Isolates each test that touches the Rovenue Rust core from the shared on-disk
/// SQLite cache.
///
/// The Rust `dirs_path()` re-reads `$HOME` on every `RovenueCore::new` call
/// (i.e. every `Rovenue.configure`), so redirecting `$HOME` to a unique temp
/// directory before `configure` is called guarantees a fresh, empty cache for
/// each test — without touching any production source.
///
/// Call `isolateRovenueHome(_:)` at the very top of `setUp()`, before any
/// `Rovenue.resetForTesting()` or `Rovenue.configure(...)`.
func isolateRovenueHome(_ testCase: XCTestCase) {
    // Capture originals once so the teardown block can restore them.
    let originalHome = ProcessInfo.processInfo.environment["HOME"]
    let originalXdg  = ProcessInfo.processInfo.environment["XDG_DATA_HOME"]

    // Create a unique temp dir for this test invocation.
    let tmpDir = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

    let path = tmpDir.path
    setenv("HOME", path, 1)
    setenv("XDG_DATA_HOME", path, 1)

    testCase.addTeardownBlock {
        // Restore originals (or unset if they weren't set).
        if let home = originalHome {
            setenv("HOME", home, 1)
        } else {
            unsetenv("HOME")
        }
        if let xdg = originalXdg {
            setenv("XDG_DATA_HOME", xdg, 1)
        } else {
            unsetenv("XDG_DATA_HOME")
        }
        // Best-effort cleanup of the temp directory.
        try? FileManager.default.removeItem(at: tmpDir)
    }
}
