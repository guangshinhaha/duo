# Phone: an installable web app first, Tauri mobile second (#152)

**Decision:** the phone target is the web client installed to the home screen (a PWA), not a Tauri iOS or Android app, until one of the triggers below fires. Tauri mobile stays the plan for what a PWA cannot do.

**What is and is not settled.** The decision below is a judgement from what each route needs; it is not a measured result. **G4 (can the owner install their own build on their own phone?) is still open**: it can only be answered by trying on the owner's phone, which this change could not do (no Xcode, CocoaPods, Android NDK or device in the environment it was written in). The web app now installs; nothing has yet run inside a Tauri phone shell, and the second acceptance criterion of #152 (the web UI running inside the phone shell on a real device) is **not met**.

Platform rules cited here are as understood when this was written (mid-2026, from knowledge that ends earlier); check them before spending money on them.

## Why a PWA first

| | Installable web app | Tauri iOS / Android |
|---|---|---|
| **Signing** | None. Add to Home Screen. | iOS needs signing. Free provisioning (a personal team) works for the owner's own phone but the profile expires every 7 days and cannot use Push Notifications; TestFlight and push need the Apple Developer Program (US$99/yr, the same gate as the Mac build in `shell-release.md`). Android installs an APK directly, free. |
| **A managed or supervised phone (G4)** | A page in Safari or Chrome is not blocked by MDM the way a sideloaded app can be. | May be refused outright. |
| **Reaching the duo** | Needs HTTPS. A page served over HTTPS cannot call the daemon at `http://100.x.y.z` (mixed content), so it works with the **hosted** daemon (HTTPS, invite-only) or a daemon with TLS (`tailscale cert`), not with the plain-HTTP tailnet address. | No mixed-content rule; can call the tailnet address directly. |
| **Push** | Web Push works on Android Chrome and, for a page **installed to the home screen**, on iOS 16.4+, with VAPID keys and no Apple account. | Native push: APNs (paid Apple account) and FCM. |
| **Buttons inside a notification (#154)** | Android Chrome yes; **iOS Safari no** (no notification actions). | Yes, on both: `tauri-plugin-notification` registers action types on mobile. |
| **Cost to try** | Nothing; it installs today. | Xcode, CocoaPods, Android Studio and the NDK, then a device. |

The surface has to be proven with real use before anyone signs anything (the mitigation `client-design.md` already names for G4), and a PWA proves it at no cost and no approval. It also shares every line with the web and the hosted build.

## What was built

- A manifest (`public/manifest.json`, standalone, the app's ground colour), icons at 192, 512 and a full-bleed 512 for masking, an Apple touch icon, and the meta tags iOS and Android read (`index.html`). All from `public/brand/duo-icon.svg`.
- Safe-area handling: the page runs edge to edge (`viewport-fit=cover`) and the shell keeps the notch and home indicator clear with `env(safe-area-inset-*)` (zero everywhere else).
- `test/Installable.test.ts` pins the manifest, that every icon exists at the size it declares, and the tags.
- Deliberately **no service worker**: installability does not need one, and an offline cache of the app shell would suggest the app works offline. It does not: with the daemon out of reach, sending is off and never queued (AR-15). Web Push (#154) will add one for push only.

## Triggers to build the Tauri phone app

Build it when any of these is true:
1. **Notification action buttons on iOS** are wanted (#154). Only a native app can show them, so this needs the Apple Developer Program.
2. The phone must reach a daemon at its **plain-HTTP tailnet address** (no HTTPS, no hosted daemon).
3. **Store presence** or background behaviour matters more than the zero-signing install.
4. The owner's phone allows their own builds and they want the native feel (safe-area, haptics, share sheet).

## The Tauri mobile runbook (for when a trigger fires, or to answer G4)

The shell is already set up for it (`src-tauri/`, bundle id `com.guangshinhaha.duo`, icons for both platforms generated from the brand icon; `tauri.conf.json` has the Android block).

- **iOS.** Install Xcode (not just the command-line tools) and CocoaPods, then `npm run tauri -- ios init` and `npm run tauri -- ios dev` with the phone plugged in, signing with a free personal team in Xcode (`src-tauri/gen/apple`). Expect the 7-day expiry and no push. Record whether install succeeds: that is G4.
- **Android.** Install Android Studio, the SDK and the NDK; set `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`; add the Rust targets (`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`); then `npm run tauri -- android init` and `npm run tauri -- android dev` on a device or an emulator.
- The web UI runs unchanged in both. What to check on a device: safe areas, the swipe on the waiting list against scrolling (`phone-interaction.md`), the software keyboard against the composer, and the daemon connection (tailnet address versus hosted).
- Record the outcome under "G4 outcome" below, and commit `src-tauri/gen/` if it is to be kept (it is generated and large; decide then).

## G4 outcome

Open. Cost table above. To close it: try the iOS runbook on the owner's phone and write what happened here (installed, expired, refused by policy, needed the paid program).
