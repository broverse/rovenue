plugins {
    id("com.android.library") version "8.5.2"
    kotlin("android") version "1.9.24"
    kotlin("plugin.serialization") version "1.9.24"
}

group = "dev.rovenue"
version = "0.7.0"

android {
    namespace = "dev.rovenue.sdk"
    compileSdk = 35

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

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    // JNA — the @aar artifact ships the native dispatcher .so files for Android.
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.android.billingclient:billing-ktx:6.2.0")
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
