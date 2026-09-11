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

// The same composite-build wiring that
// rovenue_flutter_android/android/settings.gradle carries. That file only
// applies to standalone Gradle invocations inside the plugin directory;
// when Flutter builds THIS app it pulls the plugin in as a subproject of
// this build, and this settings file is the one in effect. Without the
// substitution the app build cannot resolve the plugin's
// `dev.rovenue:sdk:0.16.0` — nothing publishes it yet — and fails at
// :app:mergeDebugAssets with "Could not find dev.rovenue:sdk:0.16.0".
//
// The explicit rule is required because sdk-kotlin's rootProject.name is
// "sdk-kotlin", so Gradle's default substitution would only match
// `dev.rovenue:sdk-kotlin`, not the real published coordinate.
includeBuild("../../../sdk-kotlin") {
    dependencySubstitution {
        substitute(module("dev.rovenue:sdk")).using(project(":"))
    }
}

include(":app")
