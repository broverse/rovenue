// Root build file — plugin versions declared once here (`apply false`),
// applied per-module in app/build.gradle.kts. Versions matched to
// packages/sdk-kotlin/build.gradle.kts (AGP 8.12.0, Kotlin 1.9.24) so the
// composite build shares one Kotlin/AGP version — a mismatch here is a
// classpath conflict waiting to happen across the includeBuild boundary.
// It happened: sdk-kotlin moved to AGP 8.12.0 and this stayed on 8.5.2, so
// the build failed with "Using multiple versions of the Android Gradle
// plugin(8.12.0, 8.5.2) in the same build is not allowed". Keep these equal.
plugins {
    id("com.android.application") version "8.12.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
