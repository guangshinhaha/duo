import { useMemo, useState } from "react";
import ORDERED_EMOJI from "unicode-emoji-json/data-ordered-emoji.json";
import EMOJI_META from "unicode-emoji-json/data-by-emoji.json";

/**
 * #291: the full picker behind the quick six's "+" — any Unicode emoji, not
 * the fixed `REACTION_CHOICES` set in `Room.tsx`. The dataset is
 * `unicode-emoji-json` (MIT, unicode.org's own data as JSON — see
 * `client-design.md` §1.2 on the licence discipline this client holds to:
 * Apache-2.0/MIT only, nothing AGPL). `m.reaction`'s `key` is already an
 * unconstrained string on the wire (`matrix.ts`'s `react`/`unreact`) — the
 * fixed six was only ever this picker's choice, never the protocol's, so
 * nothing downstream of `onPick` needed to change for this to work.
 */

interface EmojiMeta {
  readonly name: string;
  readonly slug: string;
  readonly group: string;
}

const META: Readonly<Record<string, EmojiMeta>> = EMOJI_META;
/** Unicode's own CLDR ordering — the same browse order every emoji keyboard uses. */
const ALL_EMOJI: readonly string[] = ORDERED_EMOJI;

/** A query matches an emoji's name or its underscored slug, either way round ("red heart" or "heart"). */
function matchesQuery(emoji: string, query: string): boolean {
  const meta = META[emoji];
  if (meta === undefined) {
    return false;
  }
  const name = meta.name.toLowerCase();
  const words = meta.slug.replace(/_/g, " ").toLowerCase();
  return name.includes(query) || words.includes(query);
}

export function EmojiPicker({
  recents,
  onPick,
}: {
  /** Most-recent-first (`reactionRecents.ts`) — shown ahead of the full grid until a search narrows it. */
  recents: readonly string[];
  onPick: (emoji: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();
  const results = useMemo(
    () => (trimmed === "" ? ALL_EMOJI : ALL_EMOJI.filter((emoji) => matchesQuery(emoji, trimmed))),
    [trimmed],
  );
  const showRecents = trimmed === "" && recents.length > 0;

  return (
    <div className="flex flex-col gap-3" data-testid="emoji-picker">
      <input
        aria-label="Search emoji"
        autoFocus
        className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 text-[var(--text)]"
        data-testid="emoji-picker-search"
        placeholder="Search emoji"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
        {showRecents && (
          <div className="flex flex-col gap-1">
            <p className="type-provenance text-[var(--faint)]">Recently used</p>
            <div className="flex flex-wrap gap-1" data-testid="emoji-picker-recents">
              {recents.map((emoji) => (
                <EmojiOption key={`recent-${emoji}`} emoji={emoji} onPick={onPick} />
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1" data-testid="emoji-picker-grid">
          {results.length === 0 ? (
            <p className="type-body text-[var(--muted)]">Nothing matched.</p>
          ) : (
            results.map((emoji) => <EmojiOption key={emoji} emoji={emoji} onPick={onPick} />)
          )}
        </div>
      </div>
    </div>
  );
}

function EmojiOption({ emoji, onPick }: { emoji: string; onPick: (emoji: string) => void }) {
  const meta = META[emoji];
  return (
    <button
      aria-label={meta !== undefined ? meta.name : emoji}
      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-body"
      data-testid="emoji-picker-option"
      type="button"
      onClick={() => onPick(emoji)}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  );
}
