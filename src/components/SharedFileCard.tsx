import { useEffect, useState } from "react";
import { Download, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { formatBytes } from "../workspace/sharing.js";
import type { SharedFile } from "../workspace/matrix.js";
import { ImageViewer } from "./ImageViewer.js";

/**
 * #66: one shared file as the conversation reads it — inside the sender's
 * attribution container, wherever that is (a person's message, a duo's).
 * An image renders inline once its bytes arrive through the member's own
 * authenticated fetch (the homeserver serves media only to a signed-in
 * member, and an `<img src>` can't carry that header — so the card holds
 * the blob it was handed); everything else is an honest file card — the
 * name, the declared size, the declared type, and a download. No preview
 * is faked for a type this client can't show, and nothing is fetched for a
 * file until the member asks for it.
 *
 * The facts line is the honesty: name · size · type as the sender's message
 * declared them. When the bytes can't be loaded the card keeps its facts,
 * says so when asked, and shows no thumbnail that isn't there.
 *
 * #218: clicking the thumbnail opens it full screen in `ImageViewer` — the
 * same blob already loaded above, never a second (and unauthenticated)
 * fetch against the raw `mxc://` reference. Download in the viewer is the
 * same `download` handler the card's own download link calls.
 */
export function SharedFileCard({ file, loadMedia }: { file: SharedFile; loadMedia: (url: string) => Promise<Blob | null> }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  // An image's bytes are the preview: loaded on render, released on leave.
  useEffect(() => {
    if (!file.image || file.url.length === 0) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void loadMedia(file.url).then((blob) => {
      if (cancelled || blob === null) {
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setThumbnail(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file.image, file.url, loadMedia]);

  const download = (): void => {
    setDownloading(true);
    setFailed(false);
    void loadMedia(file.url)
      .then((blob) => {
        if (blob === null) {
          setFailed(true);
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = file.name;
        anchor.click();
        URL.revokeObjectURL(objectUrl);
      })
      .finally(() => setDownloading(false));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="room-file">
      {file.image && thumbnail !== null ? (
        <>
          <button
            aria-label={`Open ${file.name} full screen`}
            className="block w-fit max-w-full cursor-zoom-in rounded-[var(--r-sm)]"
            data-testid="room-file-image-trigger"
            onClick={() => setViewerOpen(true)}
            type="button"
          >
            <img
              alt={file.name}
              className="max-h-80 w-auto max-w-full rounded-[var(--r-sm)] border border-[var(--edge)]"
              data-testid="room-file-image"
              src={thumbnail}
            />
          </button>
          <ImageViewer downloading={downloading} file={file} onDownload={download} onOpenChange={setViewerOpen} open={viewerOpen} src={thumbnail} />
        </>
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
        {file.url.length > 0 && (
          <>
            {" · "}
            <button
              className="inline-flex min-h-6 items-center underline disabled:opacity-60"
              data-testid="room-file-download"
              disabled={downloading}
              onClick={download}
              type="button"
            >
              <Download aria-hidden="true" className="mr-1 inline size-3.5" />
              Download
            </button>
          </>
        )}
      </p>
      {failed && (
        <p className="type-provenance text-[var(--refused)]" data-testid="room-file-error">
          Couldn&apos;t load {file.name} — the workspace didn&apos;t serve it. Try again.
        </p>
      )}
    </div>
  );
}
