import { useEffect, useMemo, useRef } from "react";
import { sanitizeFormattedBody } from "../workspace/sanitizeMatrixHtml.js";

/**
 * #213: another client's `formatted_body` — bold, lists, code blocks,
 * quotes, tables, links, and mentions — rendered as the formatting it is,
 * instead of this app's old "ignore `formatted_body`, show the raw markup
 * or plain words" fallback.
 *
 * `dangerouslySetInnerHTML` is safe here for exactly one reason:
 * `sanitizeFormattedBody` (`workspace/sanitizeMatrixHtml.ts`) has already
 * reduced the string to the Matrix spec's own allowed tag/attribute list
 * before this component ever sees it — nothing reaches the DOM that wasn't
 * sanitized first, and a mention anchor already reads as this app's own
 * pill (the same markup `Room.tsx`'s `MentionPill` renders, built in the
 * sanitizer from `mentionLabels` — matrix.ts's resolution, not a guess made
 * here).
 *
 * The one thing the sanitizer can't finish on its own: an `<img>` of an
 * `mxc://` reference comes back as `data-mxc-src` (browsers don't know the
 * `mxc:` scheme, so leaving it as `src` would just be a broken image). This
 * component is where that gets resolved — through `loadMedia`, the exact
 * same authenticated fetch every other piece of media in this app already
 * goes through (`SharedFileCard`, `LinkPreviewCard`) — never a direct,
 * unauthenticated fetch of the `mxc:` URI.
 */
export function MessageBodyHtml({
  formattedBody,
  mentionLabels,
  loadMedia,
}: {
  formattedBody: string;
  mentionLabels: Readonly<Record<string, string>>;
  /** The member's own authenticated fetch of a shared file's bytes — the connection's, passed down so this stays a pure render (the same contract `MessageBody`/`SharedFileCard` already keep). */
  loadMedia: (url: string) => Promise<Blob | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const sanitized = useMemo(() => sanitizeFormattedBody(formattedBody, mentionLabels), [formattedBody, mentionLabels]);

  // Each `mxc://` image's bytes are loaded once this markup is in the DOM,
  // released on leave or on the next formatted body — the same lifecycle
  // `SharedFileCard`'s own image preview keeps.
  useEffect(() => {
    const root = container.current;
    if (!root) {
      return;
    }
    let cancelled = false;
    const objectUrls: string[] = [];
    for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-mxc-src]"))) {
      const mxcUrl = image.getAttribute("data-mxc-src");
      if (!mxcUrl) {
        continue;
      }
      void loadMedia(mxcUrl).then((blob) => {
        if (cancelled || blob === null) {
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        image.src = objectUrl;
      });
    }
    return () => {
      cancelled = true;
      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [sanitized, loadMedia]);

  return (
    <div
      className="room-message-html flex flex-col gap-2 type-body [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--edge)] [&_blockquote]:pl-3 [&_code]:rounded-[var(--r-sm)] [&_code]:bg-[var(--surface-2)] [&_code]:px-1 [&_code]:py-1 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--r-sm)] [&_pre]:bg-[var(--surface-2)] [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_img]:max-h-80 [&_img]:max-w-full [&_img]:rounded-[var(--r-sm)] [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--edge)] [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-[var(--edge)] [&_td]:px-2 [&_td]:py-1"
      data-testid="room-message-html"
      ref={container}
      // `sanitized` is `sanitizeFormattedBody`'s own output, reduced to the Matrix spec's allowed tag/attribute list — never the sender's raw HTML.
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
