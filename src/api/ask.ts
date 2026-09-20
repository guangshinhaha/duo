import { apiRequest, type DuoApiConfig } from "./client.js";
import type { PublicAnswerOutcome } from "./types.js";

/**
 * The asker-facing half of `POST /ask` (duo #1/#2, building on digital-duo
 * #157/#159). Everything here is deliberately separate from `client.ts`'s
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
