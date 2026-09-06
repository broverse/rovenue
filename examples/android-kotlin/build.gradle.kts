// Root build file — plugin versions declared once here (`apply false`),
// applied per-module in app/build.gradle.kts. Versions matched to
// packages/sdk-kotlin/build.gradle.kts (AGP 8.5.2, Kotlin 1.9.24) so the
// composite build shares one Kotlin/AGP version — a mismatch here is a
// classpath conflict waiting to happen across the includeBuild boundary.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
