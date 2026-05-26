plugins {
    kotlin("jvm") version "1.9.23"
}

group = "dev.rovenue"
version = "0.0.1"

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.java.dev.jna:jna:5.14.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    systemProperty(
        "jna.library.path",
        rootProject.projectDir.resolve("../../target/release").canonicalPath
    )
}
