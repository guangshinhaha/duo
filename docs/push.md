# Phone push and notification actions (#154)

**Status: designed, not built.** Push to a phone needs a server that can send it, and the daemon has none (no subscription registry, no push sender, no keys). That is a digital-duo change, filed as digital-duo#251. Nothing in this repo can be verified end to end until it exists, so this records the contract the client and the server build to, and what the privacy page now says. It is what #154 needs before its code is worth writing.

## What exists today

- **Mac notifications** are made on the Mac by the shell (`src/notifications.ts`) from what the app already knows. Nothing goes through Apple or Google for them. A draft says only "A new draft is waiting for your review." (or, for a passed-on question or a refusal, that it was); a staged action says only that your duo needs your confirmation. A click opens the chat. Do-not-disturb and quiet hours are **this device's** own rule (`notificationPrefs.ts`), and what they held back is this device's own record.
- **Actions inside a Mac notification** are not built: the plugin registers them on mobile only (#171).
- **The mini tray** and the phone's **swipe** send a confident draft without opening the chat, by the same rule (`canSendOutside`) and writing the same record as the in-app Send.

## The rule for what a push may do

The same one everywhere a draft is sent from outside its chat:

- **Send** and **Edit** appear on a notification only for a **confident** draft for somebody else's message (`canSendOutside`). A hedged draft, a passed-on question, a refusal and a question you asked your own duo only open the chat. A staged action (T4) is never decided from a notification: it opens Confirmations.
- **Send** writes the very record the in-app Send writes: `POST /drafts/:id/outcome {outcome: "sent"}`. **Edit** opens the chat with the draft in its editor.
- Offline, nothing is queued (AR-15). A Send that cannot reach the duo leaves the draft waiting, and the notification is replaced by one that says it did not go and opens the chat. It is never retried on the owner's behalf.

## What crosses the push service

**Nothing that can be read.** A push through Apple, Google or a browser's push service carries a **draft id and a fixed line**, never the question or the draft. The phone, on receiving it, fetches the draft from the owner's duo over the device's own authenticated connection and builds the notification (with its Send and Edit actions if it is confident) on the phone. So:

- The push service learns that *something* is waiting, and when. It does not learn from whom, what was asked, or what the duo wrote.
- The words then exist on the phone, and may show on the lock screen; that is the phone's preview setting, and the privacy page says so.
- On the web (a home-screen web app), the push payload is also encrypted end to end to the browser (RFC 8291), so the id is not readable in transit either. Native pushes (APNs, FCM) are readable by Apple and Google, which is why they carry only the id and a fixed line, and why a native app needs a service extension to fetch the words.

## The contract

**Server (digital-duo#251):**
- `POST /push/subscriptions`: register this device's subscription (Web Push endpoint and keys; later an APNs or FCM token), with the device's quiet hours. `DELETE` to remove; revoking a device removes its subscriptions.
- When a draft is written, send the id-only push to each of the owner's subscriptions, unless that device's quiet hours hold it. What was held stays what it is now: waiting, visible in the app and in the count.
- **Quiet hours have to be known to the server**, because a web push must show a notification (a browser will not let a page swallow one silently), so holding it has to happen before it is sent. Do-not-disturb today is device-local; for push it becomes a field of the subscription, set from Settings on that device.
- Delivery is fire and forget with no retry queue for drafts; a subscription the push service reports gone is dropped.

**Client (when the server exists):**
- A service worker (push only; the app has none today, see `phone-shell.md`) that on `push` fetches `GET /drafts/:id` with the device token (kept where a service worker can read it), shows the notification, and on the `send` action posts the outcome and reports failure as above.
- Settings › Notifications on the phone: turn push on (asks permission from a tap, never on load), and quiet hours.

## The privacy page

`public/privacy.html` now has a Notifications section: what the Mac's notifications are, that phone push is not part of the pilot yet, and the rule above as the condition for switching it on. Phone push must not ship before that section describes the implemented behaviour; if the design here changes, that page changes first.

## Acceptance, honestly

- Sending from a push produces the same record as an in-app Send: **not built** (the contract above says it must; the tray and the swipe already do).
- Notification contents are covered in the privacy page: **done** for what exists and for the rule phone push must meet.
- Offline or failed sends surface in the app and are never silently retried: **specified above**, not built.
