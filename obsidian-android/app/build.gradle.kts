plugins {
    id("com.android.application")
}

android {
    namespace = "app.obsidian"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.obsidian"
        // 26 — минимум, где есть каналы уведомлений и нормальный foreground-сервис.
        minSdk = 26
        targetSdk = 35
        versionCode = 17
        versionName = "0.6.1"

        ndk {
            // Portable APK предназначен для современных физических телефонов.
            abiFilters += listOf("arm64-v8a")
        }
    }

    // AndroidX не подключается намеренно: активность наследуется от
    // android.app.Activity, и приложению хватает системных классов. Чем меньше
    // зависимостей у мессенджера, тем меньше поверхность supply chain.

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    packaging {
        jniLibs {
            // .so уже собран cargo-ndk и сжат — второй раз не надо.
            useLegacyPackaging = false
            // JNI загружается через libobsidian.so; второй cdylib ядра не нужен.
            excludes += "**/libobsidian_core.so"
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

/**
 * Сборка нативной части. Требует cargo-ndk и NDK:
 *   cargo install cargo-ndk
 *   sdkmanager "ndk;27.2.12479018"
 */
val cargoNdk by tasks.registering(Exec::class) {
    group = "build"
    description = "Собирает obsidian-core в jniLibs через cargo-ndk"
    workingDir = file("${projectDir}/../rust")
    isIgnoreExitValue = false

    val output = file("${projectDir}/src/main/jniLibs")
    commandLine(
        if (System.getProperty("os.name").startsWith("Windows")) "cargo.exe" else "cargo",
        "ndk",
        "-t", "arm64-v8a",
        "-o", output.absolutePath,
        "build", "--release",
    )
}

tasks.named("preBuild") {
    dependsOn(cargoNdk)
}
