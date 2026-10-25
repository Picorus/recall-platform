# Screen player (Android, Kotlin)

The app that runs on the screen's controller box: plays ads, reads GPS, counts people on the chip, signs and logs every play, works offline, updates itself.

Built in P2 (see `docs/BUILD_PLAN.md`). It is a Gradle project, not part of the pnpm workspace.

- `core/`: plain Kotlin, the rules the box follows (screen id and QR, number plates, the enrolment request). Tested on any computer against the same shared cases as the cloud (`packages/domain/test-vectors/`).
- The Android app (kiosk mode, playback) is added from P2.2.

Run the tests (Java 17 or newer): `./gradlew :core:test`
