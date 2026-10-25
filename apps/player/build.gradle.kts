// The Android plugin is only loaded where the Android SDK is (the CI runner, a developer laptop), so
// machines without it still build and test core. Both plugins share one class loader, as Kotlin's
// Android support needs.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        if (System.getenv("ANDROID_HOME") != null || file("local.properties").exists()) {
            classpath("com.android.tools.build:gradle:8.11.1")
        }
    }
}

plugins {
    kotlin("jvm") version "2.2.20" apply false
}
