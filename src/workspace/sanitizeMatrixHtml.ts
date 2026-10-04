import DOMPurify from "dompurify";
import { addressed, mentionPillClassName, userIdOfMatrixToHref } from "./mentions.js";
import { localpartOf } from "./identity.js";

/**
 * #213: another client's `formatted_body`, sanitized to the Matrix spec's
 * own allowed tag/attribute list (client-server API §m.room.message
 * msgtypes, the "m.text"/`formatted_body` section) and never shown raw.
 * `dangerouslySetInnerHTML` only ever receives this function's RETURN
 * value (`MessageBodyHtml.tsx`) — a sender's own HTML never reaches the DOM
 * directly.
 *
 * Built on DOMPurify (dual Apache-2.0/MPL-2.0; this project treats it as
 * Apache-2.0) rather than a hand-rolled tag stripper: a maintained
 * allowlisting sanitizer, not a denylist this module would have to keep
 * ahead of every new browser-parsed element. DOMPurify's own config is one
 * global attribute list, though — it has no notion of "this attribute only
 * on that tag" — so the real allowlist, the one that keeps a bare `class`
 * (which could borrow this app's own Tailwind utility classes to build a
 * phishing overlay) off every tag but `code`, or a `src` off everything but
 * a validated `mxc://` `img`, lives in the `uponSanitizeAttribute` hook
 * below, not in DOMPurify's config object.
 *
 * Two things DOMPurify is never asked to do:
 *  - Resolve a mention's label: `mentionLabels` is matrix.ts's own
 *    resolution (room membership for a person, the id's grammar for a
 *    duo — the same one #65's plain-text pills use), computed once at the
 *    seam. This module turns a surviving matrix.to user anchor into the
 *    same pill markup `Room.tsx`'s JSX pill renders, over the ALREADY
 *    fully-sanitized output — a second, harmless `innerHTML` parse of this
 *    module's own trusted output, never of the sender's.
 *  - Fetch an `mxc://` image: a bare `mxc:` URI isn't a scheme any browser
 *    knows how to load, so an `<img src="mxc://…">` would just sit broken.
 *    This function instead moves a validated `mxc://` reference to a
 *    `data-mxc-src` attribute and drops `src` outright; `MessageBodyHtml`
 *    resolves `data-mxc-src` through the same authenticated `loadMedia`
 *    every other piece of media in this app already goes through.
 */

/** The spec's suggested tag list, plus `strike` (the pre-v1.10 spelling of `s` some clients still send) for interoperability. */
const ALLOWED_TAGS = [
  "del",
  "strike",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "sup",
  "sub",
  "li",
  "b",
  "i",
  "u",
  "strong",
  "em",
  "s",
  "code",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "pre",
  "span",
  "img",
  "details",
  "summary",
  // Deprecated since v1.10 in favour of `span`'s `data-mx-*` attributes,
  // but still sent by older clients — accepted for interoperability.
  "font",
];

/** Per-tag attribute allowlist, from the spec's own "Permitted Attributes" table. Any attribute not listed here, on any tag, is stripped. */
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  span: ["data-mx-bg-color", "data-mx-color", "data-mx-spoiler", "data-mx-maths"],
  font: ["data-mx-bg-color", "data-mx-color", "color"],
  a: ["href"],
  img: ["width", "height", "alt", "title", "src"],
  ol: ["start"],
  code: ["class"],
  div: ["data-mx-maths"],
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const LANGUAGE_CLASS = /^language-[\w-]*$/;
// The spec: "provided the value is not relative and has a scheme matching
// one of: https, http, ftp, mailto, magnet". Deliberately narrower than
// DOMPurify's own default URI allowlist (which also permits tel/callto/
// cid/xmpp) and requires an explicit scheme — no relative href survives.
const HREF_SCHEME = /^(https?|ftp|mailto|magnet):/i;
const MXC_SRC = /^mxc:\/\/[^/?#]+\/[^/?#]+$/i;
const SMALL_INTEGER = /^\d{1,4}$/;

function validAttributeValue(tag: string, name: string, value: string): boolean {
  switch (name) {
    case "href":
      return tag === "a" && HREF_SCHEME.test(value);
    case "src":
      return tag === "img" && MXC_SRC.test(value);
    case "class":
      // Only `code` may carry one, and only for syntax-highlighting classes.
      return tag === "code" && value.split(/\s+/).filter(Boolean).every((token) => LANGUAGE_CLASS.test(token));
    case "color":
    case "data-mx-color":
    case "data-mx-bg-color":
      return HEX_COLOR.test(value);
    case "width":
    case "height":
      return SMALL_INTEGER.test(value);
    default:
      // alt, title, start, data-mx-spoiler, data-mx-maths: free text the
      // browser never interprets as a URI or executable code.
      return true;
  }
}

/** A detached DOMPurify instance per call — this module's own hooks must never leak onto some other caller's sanitize() mid-render. */
function sanitizeToString(html: string): string {
  const purify = DOMPurify();
  purify.addHook("uponSanitizeElement", (node, data) => {
    // Rich-reply fallback quoting (spec, "Rich replies"): clients SHOULD
    // strip this tag AND its content — the quoted words are shown again,
    // in full, by this app's own reply UI once it exists, not borrowed
    // from the sender's own fallback copy.
    if (data.tagName === "mx-reply" && node.parentNode) {
      node.parentNode.removeChild(node);
    }
  });
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    const allowed = TAG_ATTRIBUTES[tag];
    if (!allowed || !allowed.includes(data.attrName) || !validAttributeValue(tag, data.attrName, data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    if (tag === "img" && data.attrName === "src") {
      // Browsers don't know the `mxc:` scheme, so leaving it as `src`
      // would just be a broken image — moved to a data attribute the
      // renderer resolves through the authenticated media path instead.
      node.setAttribute("data-mxc-src", data.attrValue);
      data.keepAttr = false;
      return;
    }
    // Validated above against this module's OWN rules, which are
    // narrower than DOMPurify's defaults in every case that matters here
    // (no tel/callto/cid/xmpp hrefs, no relative hrefs, no unvalidated
    // data- attributes) — forceKeepAttr bypasses DOMPurify's own checks
    // rather than fighting them.
    data.forceKeepAttr = true;
  });
  try {
    return purify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: [],
      ALLOW_DATA_ATTR: false,
      RETURN_DOM: false,
      WHOLE_DOCUMENT: false,
    });
  } finally {
    purify.removeHook("uponSanitizeElement");
    purify.removeHook("uponSanitizeAttribute");
  }
}

/**
 * A mention anchor the sanitize pass kept (its href survived — it's an
 * ordinary `https://matrix.to/#/@…` permalink) rewritten into the same pill
 * `Room.tsx`'s `MentionPill` renders: the id's own grammar decides dashed
 * vs. solid, `mentionLabels` supplies the already-resolved label (falling
 * back to the localpart only in the defensive case where an anchor's id
 * wasn't among the ones matrix.ts resolved). Every other surviving anchor
 * gets `target="_blank" rel="noopener noreferrer"` — the spec's own
 * recommendation, applied by this app rather than trusted from the sender
 * (which is also why `target` isn't in the attribute allowlist above).
 *
 * Runs over `sanitizeToString`'s OWN output — a second `innerHTML` parse of
 * content this function already fully trusts, not the sender's.
 */
function rehydrateMentionsAndLinks(html: string, mentionLabels: Readonly<Record<string, string>>): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    const userId = userIdOfMatrixToHref(anchor.getAttribute("href") ?? "");
    if (userId === null) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      continue;
    }
    const label = mentionLabels[userId] ?? localpartOf(userId);
    const pill = document.createElement("span");
    pill.className = mentionPillClassName(userId);
    pill.setAttribute("data-mentioned-user", userId);
    pill.setAttribute("data-testid", "room-mention");
    pill.textContent = addressed(userId, label);
    anchor.replaceWith(pill);
  }
  return container.innerHTML;
}

/** The one export: another client's `formatted_body`, safe to hand to `dangerouslySetInnerHTML`. */
export function sanitizeFormattedBody(html: string, mentionLabels: Readonly<Record<string, string>> = {}): string {
  return rehydrateMentionsAndLinks(sanitizeToString(html), mentionLabels);
}
