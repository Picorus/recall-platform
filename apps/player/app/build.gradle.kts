import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "app.recall.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.recall.player"
        // Android 11 and newer (the controller box, docs/BUILD_PLAN.md).
        minSdk = 30
        targetSdk = 35
        versionCode = 6
        versionName = "0.7.0"
        // Checks on a real Android (the CI emulator): the screen plays and swaps without gaps (P2.5.2).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = true
        checkDependencies = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    // Video playback (Media3 ExoPlayer, Google's player for Android): same behaviour on every box.
    implementation("androidx.media3:media3-exoplayer:1.4.1")

    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}
