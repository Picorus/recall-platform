# Rider app

The rider app (`apps/rider`) is an Expo (React Native) app for Android phones. It talks to the API's
`/rider/...` routes with a session token (P4.1).

## Run it on a laptop

1. Start the laptop services and the API (see [laptop-setup.md](laptop-setup.md)). With no keys, the
   API sends sign-in codes through the fake messages adapter: nothing leaves the laptop.
2. `pnpm --filter @recall/rider web` opens the app in a browser at http://localhost:8081 (the API
   lets this origin in on a laptop; elsewhere set `RIDER_APP_ORIGINS`).
3. On an Android phone or emulator: `pnpm --filter @recall/rider start`, then open it in Expo Go.
   Set `EXPO_PUBLIC_API_URL` to the API's address the phone can reach (e.g. your laptop's Wi-Fi
   address, `http://192.168.1.20:8080`).

On a laptop the API prints each message it would send on its console ("laptop message, not sent:
sms to +91…: 123456 is your RECALL code…"): read your code there. A shared test server cannot use
the fake (it is refused off a laptop); it uses a real provider's test mode (P6).

## Tests

- `pnpm --filter @recall/rider test`: the words in all three languages, the API client.
- `pnpm --filter @recall/rider test:e2e`: builds the web version and drives it in Chromium against a
  real API and database (needs `DATABASE_URL`). `SCREENSHOT_DIR=/some/folder` saves screenshots.

## Words

Every text is in `apps/rider/src/i18n.ts` in Telugu, Hindi and English; a test fails if a word is
missing in one of them or written in the wrong script. Fonts (Anek Telugu, Devanagari, Latin; IBM
Plex Mono) are bundled in the app, so phones without them still show them correctly.

## Signing a rider out

A rider signs out on the app. Staff ending a rider's sessions (a lost phone) comes with the admin
rider page's next change; until then, `endRiderSession` in `packages/db` does it (logged in the
audit log under riders).
