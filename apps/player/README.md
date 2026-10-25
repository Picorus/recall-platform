# Screen player (Android, Kotlin)

The app that runs on the screen's controller box: plays ads, reads GPS, counts people on the chip, signs and logs every play, works offline, updates itself.

Built in P2 (see `docs/BUILD_PLAN.md`). It is a Gradle project, not part of the pnpm workspace.

- `core/`: plain Kotlin, the rules the box follows (screen id and QR, number plates, the enrolment request). Tested on any computer against the same shared cases as the cloud (`packages/domain/test-vectors/`).
- `app/`: the Android app (P2.2 on: kiosk mode as device owner, watchdog). Built where the Android SDK is installed (`ANDROID_HOME` set): `./gradlew :app:assembleDebug`. CI also runs it on an Android 11 emulator: the playback checks (`./gradlew :app:connectedDebugAndroidTest`, P2.5.2), then the kiosk checks (`ci/kiosk-check.sh`).
- Setting up a box at the warehouse: `docs/RUNBOOKS/screen-setup.md`.

Run the tests (Java 17 or newer): `./gradlew :core:test`
