# The Mac shell (#151)

The Mac app is the web client in a Tauri v2 window (`src-tauri/`), unsigned (see `shell-release.md`). This is what the shell adds, and what has and has not been run.

## What it does

| Piece | How | Where |
|---|---|---|
| **Waiting count** in the dock, the menu bar and the window title | One number, `useWaitingCount`; the dock badge, the tray title and `document.title` mirror it | `src/shell/ChatShell.tsx` (`WaitingMirror`), `set_pending_count` in `src-tauri/src/lib.rs` |
| **Mini tray**: click the menu-bar icon | A small always-on-top popover window (label `tray`, loaded at `index.html#tray`) that hides when it loses focus. It lists what waits, oldest first. A **confident** draft shows what would be sent and has **Send**; everything else has **Open**, which brings the app forward at that chat | `src/tray/TrayPopover.tsx`, `toggle_tray_window` and `open_in_app` in `lib.rs` |
| **Same record as an in-app Send** | The tray posts the very same `POST /drafts/:id/outcome {outcome: "sent"}` through the same hook; a test compares the two requests | `test/TrayPopover.test.tsx` |
| **Who may send from outside** | `canSendOutside`: confident, for somebody else's message, undecided. A hedged draft, a passed-on question, a refusal and a question you asked your own duo never get Send; an action staged for your yes (T4) is only counted and opened, never decided | `src/shell/waiting.ts` |
| **Offline** | Send is disabled and says so; never queued (AR-15) | `TrayPopover` |
| **Native menu** | ⌘, Settings, ⌘0 Waiting on you, ⌘K Search, ⌘I inspector, ⌘1–9 go to chat n, plus Edit (so copy and paste work) and Window. Each item re-issues the key the page already handles, so a shortcut has one handler in a browser and in the shell. J/K stay in the page: a bare letter in a menu would take the key from every text box | `build_menu` in `lib.rs`, `wireMenu` in `src/shell/native.ts` |
| **Window** | 1120×760 by default and never below 720×480; the inspector is a third column from 1100px and gives way below that (#147) | `tauri.conf.json`, `ChatShell.tsx` |
| **Icons** | The app icon is generated from `public/brand/duo-icon.svg` (`npx tauri icon public/brand/duo-icon.svg`); the menu-bar icon is a monochrome template image of the mark (`icons/tray.png`) that macOS tints for light, dark and selected | `src-tauri/icons/` |

## What has not been verified, honestly

- **It compiles** (`cargo check` on Rust 1.98) and the client half is tested. **It has not been run as an app** in this change: the menu accelerators, the popover's position under the icon, hide-on-blur and the template icon need one manual pass on a Mac (`npm run tauri dev`, then click the icon; try ⌘K, ⌘1, ⌘I, ⌘,).
- **Send and Edit buttons inside a macOS notification are not built.** `tauri-plugin-notification` 2.4 registers action buttons on mobile only (`register_action_types` is `#[cfg(mobile)]`), and its desktop backend cannot show them. A notification click still opens the chat. Buttons need native `UNNotificationAction` code, and a bundle macOS agrees to notify for, which an unsigned build may not give. Until then the mini tray is where a draft is sent without opening the app. The same rule (`canSendOutside`) is what a phone push action (#154) will use.
- The tray window's hash address (`index.html#tray`) is a fallback pair: if a build drops the fragment, the client also recognises the window by its label.
- Signing and notarisation stay out of scope; the decision in `shell-release.md` stands.
