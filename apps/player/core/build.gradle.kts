import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
}

// Bytecode for Java 17, what Android runs; built with whatever JDK 17+ is installed.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
}

tasks.test {
    useJUnitPlatform()
    // The shared cases live with the cloud's code, so both sides always test the same thing.
    systemProperty("recall.vectors", rootProject.file("../../packages/domain/test-vectors").absolutePath)
}
