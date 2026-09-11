pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}

// No includeBuild of packages/sdk-kotlin here, deliberately. This app
// resolves `dev.rovenue:sdk` from mavenLocal (declared in build.gradle.kts),
// which is what the plugin's own build.gradle documents and what a real
// consumer does — it gets an AAR, not our Gradle build. Composing sdk-kotlin
// in instead drags its Android Gradle plugin into this build alongside the
// one below, and Gradle refuses two: "Using multiple versions of the Android
// Gradle plugin(8.12.0, 9.1.0) in the same build is not allowed". Publish it
// first (`./gradlew publishToMavenLocal` in packages/sdk-kotlin); sdk.yml
// does exactly that before `flutter build apk`.
include(":app")
