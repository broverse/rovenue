// examples/android-kotlin/settings.gradle.kts
//
// Consumes packages/sdk-kotlin as a Gradle *composite build* (includeBuild),
// NOT a published Maven artifact — mirrors exactly what the Expo config
// plugin (packages/sdk-rn/plugin/withRovenueAndroid.ts) patches into a real
// consumer's settings.gradle.kts:
//
//   includeBuild("../../../packages/sdk-kotlin")
//
// (that plugin's path is relative to an Expo app's android/ dir, three
// levels down from the package; ours is relative to this file, two levels
// up to the repo root then into packages/sdk-kotlin.)
//
// Gradle's DEFAULT included-build substitution matches by the included
// project's own Gradle project name — sdk-kotlin's is "sdk-kotlin" (its
// settings.gradle.kts `rootProject.name`), NOT the maven-publish coordinate
// its build.gradle.kts registers (`dev.rovenue:sdk`, the artifactId the RN
// bridge and this app's own dependency line both use). Left to the
// default, Gradle would only auto-substitute `dev.rovenue:sdk-kotlin` — an
// explicit `dependencySubstitution` rule is required to map the REAL
// coordinate onto the included project. This mirrors
// packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle,
// which documents and needs the identical rule for the identical reason.
includeBuild("../../packages/sdk-kotlin") {
    dependencySubstitution {
        substitute(module("dev.rovenue:sdk")).using(project(":"))
    }
}

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "android-kotlin-example"
include(":app")
