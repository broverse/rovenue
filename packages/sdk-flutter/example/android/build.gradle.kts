allprojects {
    repositories {
        google()
        mavenCentral()
        // Dev override so a locally-published `dev.rovenue:sdk` (e.g. via
        // `./gradlew publishToMavenLocal` in packages/sdk-kotlin) resolves
        // here instead of a not-yet-published Maven Central coordinate.
        // The task-8-brief.md calls this file `build.gradle`; the current
        // `flutter create` template generates Kotlin DSL (`build.gradle.kts`)
        // instead — this is that same file under its real name.
        mavenLocal()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
