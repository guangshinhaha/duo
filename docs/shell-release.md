# Shell release: signing decision record (#42)

**Decision:** the Mac build ships unsigned and un-notarised. `npm run tauri --
build` produces a real `.app` and `.dmg`, but neither carries a code signature
from Apple, and nothing has been through notarisation.

## Why

Signing requires an Apple Developer Program membership (US$99/year) and a
**Developer ID Application** certificate issued to it. Neither exists for this
project. There is no certificate to sign with, so there is nothing to decide
until one does — an ad-hoc signature (signing with `-`, which anyone can do)
would clear Gatekeeper's *malware* check but not its *unidentified developer*
check, which buys nothing over shipping unsigned for a personal build.

## What the user sees (the Gatekeeper consequence)

On first launch of an unsigned app, macOS Gatekeeper blocks it:

- Double-clicking the `.app` shows *"Duo" cannot be opened because the
  developer cannot be verified* — with only a **Cancel** button, no **Open**.
- The working path is **System Settings → Privacy & Security → Open Anyway**
  (or `xattr -dr com.apple.quarantine /Applications/Duo.app` for the
  command-line habit this tool is built for). After that one approval, the app
  launches normally forever.
- A `.dmg` full of an unsigned app triggers the same flow on the app inside it.
- The trade is accepted consciously: this is a single-user tool distributed to
  the machine that built it, and the alternative — shipping no `.app` at all —
  is strictly worse.

## The path to fixing it, when it's worth fixing

1. Join the Apple Developer Program; create a **Developer ID Application**
   certificate in Xcode or with `certool`.
2. Point the build at it — Tauri reads signing from the environment, no
   config change needed:
   `APPLE_SIGNING_IDENTITY="Developer ID Application: <name>" npm run tauri -- build`
3. Notarise the `.dmg`: an app-specific-password
   (`xcrun notarytool store-credentials`) plus `APPLE_ID`, `APPLE_PASSWORD`,
   and `APPLE_TEAM_ID` in the environment make `tauri build` submit and staple
   the ticket automatically.
4. Update this record and the README note when the Gatekeeper paragraph above
   stops being true.

Until then, this file is the honest statement of what the build is.
