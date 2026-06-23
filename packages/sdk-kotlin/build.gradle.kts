plugins {
    id("com.android.library") version "8.5.2"
    kotlin("android") version "1.9.24"
    kotlin("plugin.serialization") version "1.9.24"
    `maven-publish`
    signing
}

group = "dev.rovenue"
version = "0.16.0"

android {
    namespace = "dev.rovenue.sdk"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    // The Android core libs are cross-compiled + staged into src/main/jniLibs by
    // packages/core-rs/scripts/build-android.sh (renamed to libuniffi_librovenue.so
    // so the generated binding's hard-coded library name resolves on-device). AGP
    // packages this dir into the AAR; declared explicitly to document the contract.
    sourceSets["main"].jniLibs.srcDir("src/main/jniLibs")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }

    // Publish the release variant as an AAR with sources + (empty) javadoc jars
    // — Maven Central requires all three. AGP wires the `release` software
    // component consumed by the maven-publish block below.
    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

dependencies {
    // JNA — the @aar artifact ships the native dispatcher .so files for Android.
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.android.billingclient:billing:9.1.0")
    implementation("androidx.lifecycle:lifecycle-process:2.6.2")

    // Host-JVM unit tests run JNA on the desktop, which needs the regular
    // jar's bundled libjnidispatch.jnilib — the @aar artifact strips it
    // (it only ships the Android .so flavours).
    testImplementation("net.java.dev.jna:jna:5.14.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("io.mockk:mockk:1.13.10")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// ---- Maven publishing -------------------------------------------------------
// Publishes the release AAR (+ sources/javadoc) to a Maven repository. NOTHING
// is hardcoded — the target repo, credentials, and signing key all come from
// Gradle properties or env vars at publish time, so no secret lands in git:
//
//   ./gradlew :publishReleasePublicationToReleaseRepository \
//     -Provenue.publish.url=https://s01.oss.sonatype.org/service/local/staging/deploy/maven2/ \
//     -Provenue.publish.user=$OSSRH_USER -Provenue.publish.password=$OSSRH_PASSWORD \
//     -Provenue.signing.key="$GPG_PRIVATE_KEY" -Provenue.signing.password=$GPG_PASSWORD
//
// To publish to GitHub Packages instead, set rovenue.publish.url to
//   https://maven.pkg.github.com/rovenue/rovenue
// With no rovenue.publish.url set, publishing targets a local build/repo dir so
// the config can be exercised offline. Signing activates only when a key is
// supplied, keeping local `gradle build`/`test` unsigned and frictionless.
fun publishProp(name: String): String? =
    (findProperty(name) as String?) ?: System.getenv(name.replace('.', '_').uppercase())

publishing {
    publications {
        register<MavenPublication>("release") {
            // The android `release` component only exists after evaluation.
            afterEvaluate { from(components["release"]) }
            groupId = project.group.toString()
            // Coordinate MUST be `dev.rovenue:sdk` — that's what the RN Android
            // module (android/build.gradle) and the Expo config plugin
            // (sdk-rn/plugin/withRovenueAndroid.ts) inject as
            // `implementation("dev.rovenue:sdk:<v>")`. Any other artifactId is
            // unresolvable for those consumers.
            artifactId = "sdk"
            version = project.version.toString()
            pom {
                name.set("Rovenue Android SDK")
                description.set(
                    "Rovenue subscription / virtual-currency SDK — Kotlin façade over the librovenue Rust core.",
                )
                url.set("https://github.com/rovenue/rovenue")
                licenses {
                    license {
                        name.set("AGPL-3.0-only")
                        url.set("https://www.gnu.org/licenses/agpl-3.0.html")
                    }
                }
                developers {
                    developer {
                        id.set("rovenue")
                        name.set("Rovenue")
                    }
                }
                scm {
                    url.set("https://github.com/rovenue/rovenue")
                    connection.set("scm:git:https://github.com/rovenue/rovenue.git")
                    developerConnection.set("scm:git:ssh://git@github.com/rovenue/rovenue.git")
                }
            }
        }
    }
    repositories {
        maven {
            name = "release"
            url = uri(
                publishProp("rovenue.publish.url")
                    ?: layout.buildDirectory.dir("repo").get().asFile.toURI().toString(),
            )
            val user = publishProp("rovenue.publish.user")
            val pass = publishProp("rovenue.publish.password")
            if (user != null && pass != null) {
                credentials {
                    username = user
                    password = pass
                }
            }
        }
    }
}

signing {
    val signingKey = publishProp("rovenue.signing.key")
    val signingPassword = publishProp("rovenue.signing.password")
    if (signingKey != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["release"])
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
    systemProperty(
        "jna.library.path",
        rootProject.projectDir.resolve("../../target/release").canonicalPath,
    )
    // The cargo cdylib is `librovenue` (target/release/librovenue.dylib) but the
    // UniFFI binding's findLibraryName() returns "uniffi_librovenue". Point the
    // loader at the actual artifact name via UniFFI's documented override hook.
    systemProperty("uniffi.component.librovenue.libraryOverride", "rovenue")
    // The public FFI RovenueCore constructor opens an on-disk SQLite cache at
    // $HOME/Library/Application Support/Rovenue/rovenue.db (or the XDG/TMP
    // equivalent). Point HOME at an isolated, per-build directory so the unit
    // tests never read or pollute the developer's real home cache, and so each
    // `test` run starts from a clean slate.
    val testHome = layout.buildDirectory.dir("test-home").get().asFile
    environment("HOME", testHome.absolutePath)
    environment("XDG_DATA_HOME", testHome.resolve("xdg").absolutePath)
    doFirst {
        testHome.deleteRecursively()
        testHome.mkdirs()
    }
    // Fork a fresh JVM per test class. Combined with the per-class DB wipe in
    // the test setup, this keeps the Rust core's persisted identity / cache
    // state from leaking across test classes.
    setForkEvery(1)
}
