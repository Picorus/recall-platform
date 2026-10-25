# Set up a screen box at the warehouse

What a technician does once per controller box, before it goes on a bike (P2.1–P2.2).

1. **Fresh box.** Factory state, no Google account added (Android allows a device owner only on a box with no accounts).
2. **Install the player.** Connect the box by USB to the warehouse laptop and run:
   `adb install recall-player.apk`
3. **Make the player the device owner** (once; this is what lets it lock the box):
   `adb shell dpm set-device-owner app.recall.player/.RecallAdminReceiver`
   The answer must say "Success". From now on the player is the home screen, starts on power-up, cannot be closed, and the box cannot be factory-reset or started in safe mode from the box.
4. **Start it:** `adb shell am start -n app.recall.player/.MainActivity`. The screen shows RECALL and stays on.
5. **Enrol** (P2.1): the player makes its keys and sends its enrolment; the warehouse screen shows the new screen id. Print the QR sticker and fix it on the screen.
6. **Fit** (P2.14, later): at fitting, the rider app scans the QR and runs the fitting check.

The production player closes the USB debugging port itself (release builds), so step 2–4 are done before the box leaves the warehouse; later changes arrive as remote updates (P2.13).

If step 3 says "Not allowed to set the device owner because there are already some accounts on the device": remove the account or factory-reset the box, then start again.
