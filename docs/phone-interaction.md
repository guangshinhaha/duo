# The phone interaction model (#153)

The phone is the chat list and one screen at a time: **Chats → Chat → Profile or a sheet**, pushed with the browser's history, so the system back gesture is the way out of every level. No tab bar; Settings is behind the list header (⚙). This is what the web client does at widths below 768px and inside the phone shell once it exists (#152).

## Clearing what waits

The **Waiting on you** list is the one-handed flow. Each row is a chat with a draft behind it; on a phone the row is swipeable:

| Gesture | What it does | When |
|---|---|---|
| **Swipe left** | Sends the draft (the same `POST /drafts/:id/outcome {outcome: "sent"}` as the tray's Send) | Only a **confident** draft, alone behind its row, and only while the daemon answers |
| **Swipe right** | Dismisses it, held for the 5-second undo window before anything is written | A draft alone behind its row that the duo did not refuse |
| Tap | Opens the chat, where the tray has Send, Edit, Dismiss, **Why?** | Always |

A row with several drafts, a hedged draft, a passed-on question, a refusal, or a question you asked your own duo has no swipe-send: `swipeActionsOf` (`src/shell/waiting.ts`) is the one rule, and a test pins it. A swipe never sends blind: a row that can be swiped left shows the words that would be sent, behind the duo's line, as it does everywhere. Three confident drafts clear in three gestures. Offline, nothing is swipeable (a decision is never queued).

A swipe is a shortcut over buttons that always exist, never the only way: everything it does is a tap away in the chat's tray.

## The rest

- **Why?** is a bottom sheet, and the back gesture closes it before leaving the chat (`useBackClosesSheet`); closing it any other way gives its history entry back.
- Every control is at least 44px; movement follows the finger and the snap back turns its transition off under `prefers-reduced-motion`.
- Vertical movement stays the page's scroll (`touch-action: pan-y`); a swipe locks to the horizontal only after 10px and a full swipe needs 96px or 35% of the row, so a scroll that drifts or a tap that slips decides nothing.

## Not verified

Tested with simulated pointer events in a DOM. Not yet run on a real phone: the phone shell needs #152 (device builds), and mobile Safari and Chrome need a pass with a real finger (scroll versus swipe on a long list is the thing to feel).
