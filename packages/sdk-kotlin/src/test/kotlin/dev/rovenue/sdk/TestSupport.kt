package dev.rovenue.sdk

import java.io.File

/**
 * Test-only helpers for isolating the Rust core's on-disk cache between tests.
 *
 * The public FFI `RovenueCore` constructor opens a persistent SQLite cache
 * under the process `HOME` (see `default_db_path()` in core-rs). The Gradle
 * test task points `HOME`/`XDG_DATA_HOME` at an isolated per-build directory,
 * but within a single run that file is still shared across configures. Calling
 * [wipeCoreCache] from a test's setup guarantees a clean cache so persisted
 * identity / entitlement state from another test never leaks in.
 */
internal object TestSupport {
    /** Delete the Rust core's on-disk cache file(s) under the isolated HOME. */
    fun wipeCoreCache() {
        val home = System.getenv("HOME") ?: return
        val candidates = listOf(
            File(home, "Library/Application Support/Rovenue"),       // macOS
            File(System.getenv("XDG_DATA_HOME") ?: "$home/.local/share", "rovenue"), // Linux/XDG
            File(home, ".local/share/rovenue"),                       // Linux fallback
        )
        for (dir in candidates) {
            if (!dir.exists()) continue
            dir.listFiles()
                ?.filter { it.name.startsWith("rovenue.db") }
                ?.forEach { it.delete() }
        }
    }
}
