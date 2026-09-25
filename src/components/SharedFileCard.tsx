import { Download, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { formatBytes } from "../workspace/sharing.js";
import type { SharedFile } from "../workspace/matrix.js";

/**
 * #66: one shared file as the conversation reads it — inside the sender's
 * attribution container, wherever that is (a person's message, a duo's).
 * An image renders inline from the member's own authenticated media URL
 * (the stack makes thumbnails cheap: the `<img>` IS the thumbnail, the
 * homeserver serves the bytes); everything else is an honest file card —
 * the name, the declared size, the declared type, and a download. No
 * preview is faked for a type this client can't show.
 *
 * The facts line is the honesty: name · size · type as the sender's message
 * declared them, with a download that reaches for the same reference. When
 * the seam can't translate the reference to a URL this member can load, the
 * card keeps its facts and offers no link that would fail.
 */
export function SharedFileCard({ file, mediaUrl }: { file: SharedFile; mediaUrl: (url: string) => string | null }) {
  const href = file.url.length > 0 ? mediaUrl(file.url) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="room-file">
      {file.image && href !== null ? (
        <img
          alt={file.name}
          className="max-h-80 w-auto max-w-full rounded-[var(--r-sm)] border border-[var(--edge)]"
          data-testid="room-file-image"
          src={href}
        />
      ) : (
        <div
          className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 type-body"
          data-testid="room-file-card"
        >
          {file.image ? (
            <ImageIcon aria-label="Shared image" className="size-4 shrink-0" />
          ) : (
            <FileIcon aria-label="Shared file" className="size-4 shrink-0" />
          )}
          <span className="break-all" data-testid="room-file-name">
            {file.name}
          </span>
        </div>
      )}
      <p className="type-provenance text-[var(--muted)]" data-testid="room-file-facts">
        <span className="break-all">{file.name}</span> · {formatBytes(file.size)}
        {file.mimeType.length > 0 && <> · {file.mimeType}</>}
        {href !== null && (
          <>
            {" · "}
            <a className="underline" data-testid="room-file-download" download={file.name} href={href}>
              <Download aria-hidden="true" className="mr-1 inline size-3.5" />
              Download
            </a>

          </>
        )}
      </p>
    </div>
  );
}
