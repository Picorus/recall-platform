// The screen player (P2). `core` is plain Kotlin: the rules the box follows, tested on any computer
// against the same shared cases as the cloud. The Android app (kiosk, playback) is added in P2.2.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "recall-player"
include("core")
