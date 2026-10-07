/**
 * duo#301: slash commands in the composer — a Lexical typeahead on "/",
 * offered only at the very start of the message (never mid-sentence: a "/"
 * after any other character is just a character, the same restraint the
 * mention offer gives "@" after whitespace only, `mentionOffer.ts`).
 *
 * Four of the five named commands have somewhere real to go: `/duo` opens
 * Your duo (`#duo`, always present, "works with no workspace" —
 * vocabulary.md); `/summarize` reuses the exact catch-up mechanism #280
 * already shipped (`onCatchUp`), on demand rather than only past its unread
 * threshold; `/later <words>` and `/remind <words>` reuse duo#299's own
 * "Later" mechanism (`shell/later.ts`'s `addLaterItem`, the account's own
 * `connection.later`/`setLater`, and — for `/remind`, to pick when —
 * `SaveToLaterDialog`, the exact dialog the composer's own "Save to Later"
 * button opens), rather than a second, parallel one this PR would invent.
 * `/poll` names a mechanism that doesn't exist yet (duo#293 is still open,
 * confirmed against `origin/main` before this file was written): it stays
 * listed (so a member typing "/poll" learns it's a real, coming command,
 * not a typo) but `available: false`, and picking it shows
 * `unavailableNotice` instead of doing anything — never a silent no-op,
 * never invented storage.
 */

export type SlashCommandId = "duo" | "summarize" | "later" | "remind" | "poll";

export interface SlashCommand {
  readonly id: SlashCommandId;
  /** The word after "/", exactly as typed — always `id` itself; kept separate so the typeahead's matching and the token's own text never drift apart. */
  readonly command: string;
  readonly description: string;
  readonly available: boolean;
  /** Shown in place of running anything, only when `available` is false. */
  readonly unavailableNotice?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "duo", command: "/duo", description: "Open Your duo", available: true },
  { id: "summarize", command: "/summarize", description: "Catch up on this conversation", available: true },
  { id: "later", command: "/later", description: "Save words for later", available: true },
  { id: "remind", command: "/remind", description: "Save words with a reminder", available: true },
  {
    id: "poll",
    command: "/poll",
    description: "Run a poll — coming soon",
    available: false,
    unavailableNotice: "Polls aren't built yet — nothing was sent.",
  },
];

/** What follows "/" matches a command's own id as a prefix, case-insensitively — the same shape `mentionOffer`'s matching takes. */
export function slashCommandOffer(fragment: string): readonly SlashCommand[] {
  const lower = fragment.toLowerCase();
  return SLASH_COMMANDS.filter((candidate) => candidate.id.startsWith(lower));
}

/**
 * The command being typed, read from the text before the caret — unlike a
 * mention, only at the true start of the line: nothing may precede the "/"
 * at all (no leading whitespace, no other words), since the typeahead is
 * for PICKING a command, before any argument exists to type — the moment a
 * space follows the word, this stops matching and the dropdown closes,
 * leaving an ordinary line `parseSlashCommand` (below) still reads as one.
 */
export function slashCommandTokenBeforeCaret(text: string): { leadOffset: number; fragment: string; token: string } | null {
  const match = /^(\/[a-zA-Z]*)$/.exec(text);
  if (!match) {
    return null;
  }
  return { leadOffset: 0, fragment: match[1]!.slice(1), token: match[1]! };
}

export type SlashCommandParse =
  | { readonly kind: "none" }
  | { readonly kind: "known"; readonly command: SlashCommand; readonly argument: string }
  | { readonly kind: "unknown"; readonly raw: string };

/**
 * What a composed, about-to-send body is: not a command at all, a known one
 * (by its id, the first word after "/", case-insensitive, with `argument`
 * whatever followed it, trimmed — "" when there's nothing — `/duo` and
 * `/summarize` ignore it, `/later`/`/remind` are the words saved), or a
 * "/"-shaped word this product doesn't recognise — the AC3 case
 * ("Unknown commands are sent as text only after confirmation").
 */
export function parseSlashCommand(body: string): SlashCommandParse {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "none" };
  }
  const withoutSlash = trimmed.slice(1);
  const spaceAt = withoutSlash.search(/\s/);
  const word = (spaceAt === -1 ? withoutSlash : withoutSlash.slice(0, spaceAt)).toLowerCase();
  const argument = spaceAt === -1 ? "" : withoutSlash.slice(spaceAt + 1).trim();
  const command = SLASH_COMMANDS.find((candidate) => candidate.id === word);
  return command ? { kind: "known", command, argument } : { kind: "unknown", raw: trimmed };
}
