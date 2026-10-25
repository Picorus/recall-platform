// The screen player (P2). `core` is plain Kotlin: the rules the box follows, tested on any computer
// against the same shared cases as the cloud. `app` is the Android app that runs on the box; it is
// built where the Android SDK is installed (the CI runner, a developer laptop).
pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "recall-player"
include("core")
if (System.getenv("ANDROID_HOME") != null || file("local.properties").exists()) include("app")
