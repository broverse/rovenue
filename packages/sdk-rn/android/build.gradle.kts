// Gradle module for the React Native (Nitro) Android binding to the
// Rovenue SDK. Source-only in M5 — no Gradle execution is attempted
// in this milestone. The consuming RN app's autolinking step in M6
// will wire this module into its settings.gradle.kts and trigger the
// actual Android library build.

plugins {
    id("com.android.library") version "8.2.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.23" apply false
}

apply(plugin = "com.android.library")
apply(plugin = "org.jetbrains.kotlin.android")

configure<com.android.build.gradle.LibraryExtension> {
    namespace = "dev.rovenue.sdkrn"
    compileSdk = 34
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // M4 Kotlin façade — depended on by Gradle composite build or
    // local project include. The exact include() path will be
    // configured by the consuming app's settings.gradle.kts in M6.
    "implementation"(project(":sdk-kotlin"))

    "implementation"("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    "implementation"("com.facebook.react:react-android:0.73.0")

    // Nitro Modules Android runtime — version pinned alongside the JS
    // peer dep `react-native-nitro-modules` (see packages/sdk-rn/package.json).
    // Will be reconciled in M6 when Nitrogen is wired into the build.
    "implementation"("com.margelo.nitro:nitro-modules:0.20.0")
}
