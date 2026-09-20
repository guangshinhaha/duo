import { ApiRequestError, apiRequest, type DuoApiConfig } from "./client.js";
import type { PublicAnswerOutcome } from "./types.js";

/**
 * The asker-facing half of `POST /ask` (duo #1/#2, building on digital-duo
 * #158/#159). Everything here is deliberately separate from `client.ts`'s
 * device-token world: an ask link's token is a distinct credential minted
 * for one asker, not a `duo pair` device token, so it gets its own config
 * type and its own loader rather than quietly reusing `DuoApiConfig` —
 * the types sharing a shape (`baseUrl` + `token`) is transport fact, not
 * permission fact. (The transport itself is identical — Bearer + JSON —
 * which is why this does reuse `apiRequest`.)
 */
export interface AskLinkConfig {
  /** The daemon's base URL, carried in the link's `#host=` fragment. */
  baseUrl: string;
  /** The bearer *ask token* carried in the link's `#token=` fragment. */
  token: string;
}

/**
 * Reads the connection details out of an ask link's hash —
 * `ask.html#host=<encoded baseUrl>&token=<encoded ask token>`. Hash, not
 * query string, so the token never rides along in a `Referer` to whatever
 * else the page loads (here: nothing, but the shape shouldn't depend on
 * that). Link generators are expected to `encodeURIComponent` each value;
 * `URLSearchParams` decodes both ways.
 */
export function parseAskLink(hash: string): AskLinkConfig | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const baseUrl = params.get("host");
  const token = params.get("token");
  return baseUrl && token ? { baseUrl, token } : null;
}

/** `POST /ask` — one question in, one `PublicAnswerOutcome` out (see `types.ts` for why the two non-answer variants must render verbatim). */
export async function askQuestion(config: AskLinkConfig, question: string): Promise<PublicAnswerOutcome> {
  return apiRequest(config as DuoApiConfig, "/ask", {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

/**
 * A zero-question `POST /ask`, used once at page load to fail a dead link
 * *before* the asker types anything (#2's expired-link acceptance
 * criterion: no question box on a link that has expired or been revoked).
 * The daemon authenticates before it validates the body (digital-duo
 * #159's auth hook runs on every `/ask` request), so a 401 here means the
 * link itself is dead — unknown, expired, or revoked, kind-blind by
 * design (R1) — while the 400 "question is required" that a *good* token
 * gets back proves the token authenticated. The empty question makes this
 * side-effect-free: the route rejects it before any answering happens, so
 * no draft is written and no ask is logged.
 *
 * Anything other than a 401 — the daemon unreachable, a 429, a 5xx — says
 * nothing about the link, so this reports `true` (usable) and lets the
 * submit path surface the real error when one exists.
 */
export async function isAskLinkUsable(config: AskLinkConfig): Promise<boolean> {
  try {
    await askQuestion(config, "");
    return true;
  } catch (error) {
    return !(error instanceof ApiRequestError && error.status === 401);
  }
}
