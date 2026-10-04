import { marked } from "marked";

/**
 * #216: markdown → HTML for a sent message's `formatted_body` — bold,
 * italic, lists, inline code and fenced code blocks, the plain syntax the
 * composer already lets a member type. `marked` (MIT; `node_modules/marked`
 * carries its own LICENSE file, named in the PR) does the actual parsing —
 * this module is the one seam that imports it, the same shape every other
 * single-library door in this codebase takes.
 *
 * `breaks: true` matters here specifically: the composer's Enter is already
 * a newline, not a send (#27) and not a new paragraph — a member writing two
 * short lines with no blank line between them expects two lines back, the
 * same words `body` (the plain half, always sent alongside this) already
 * carries. Bare CommonMark would fold them into one line; `breaks` is what
 * keeps the formatted half honest to what the plain half says.
 *
 * This module speaks to `marked` and nothing else — `matrix.ts`'s send path
 * and this file's own tests are the only two things that need to know a
 * markdown library is involved at all.
 */
export function markdownToHtml(source: string): string {
  return marked.parse(source, { async: false, breaks: true, gfm: true }) as string;
}
