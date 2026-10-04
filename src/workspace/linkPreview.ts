/**
 * #219: the first link a message body carries — this client shows at most
 * one preview per message (Cinny's own convention, approach only: the
 * clutter of a card per link is worse than missing the second one). The
 * match is reasonably careful (http/https, stops before whitespace or a
 * bracket/paren/quote so a URL dropped mid-sentence or inside "(...)"
 * doesn't drag the wrapper in) without going further: this client renders no
 * markdown and no code spans yet (#213/#216 not landed as of this writing),
 * so there is no fenced or inline code to exclude a link from matching
 * inside. The day one of those ships, a link inside a code span should stop
 * counting as a link here.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']+/i;

/** A sentence's trailing punctuation is not part of the URL it follows. */
const TRAILING_PUNCTUATION = /[.,!?:;]+$/;

/** The first link in `body`, trimmed of trailing sentence punctuation — null when the body carries none. */
export function firstLinkOf(body: string): string | null {
  const match = URL_PATTERN.exec(body);
  if (match === null) {
    return null;
  }
  const url = match[0].replace(TRAILING_PUNCTUATION, "");
  return url.length > 0 ? url : null;
}
