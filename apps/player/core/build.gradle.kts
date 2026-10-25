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
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    // MQTT client (Eclipse Paho, plain Java: runs the same on the box and in tests).
    implementation("org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5")
    // Test certificates for the secure line (tests only).
    testImplementation("org.bouncycastle:bcpkix-jdk18on:1.78.1")
}

tasks.test {
    useJUnitPlatform()
    // The shared cases live with the cloud's code, so both sides always test the same thing.
    systemProperty("recall.vectors", rootProject.file("../../packages/domain/test-vectors").absolutePath)
    // The test media the emulator check also uses (P2.5.2).
    systemProperty("recall.androidTestAssets", rootProject.file("app/src/androidTest/assets").absolutePath)
    // The broker's production settings, for the line test against a real broker (RECALL_BROKER_TEST=1).
    systemProperty("recall.emqxTemplate", rootProject.file("../../infra/emqx/emqx.conf.template").absolutePath)
    environment("RECALL_BROKER_TEST", System.getenv("RECALL_BROKER_TEST") ?: "")
}
