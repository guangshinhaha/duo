import { useEffect, useState } from "react";
import type { UrlPreview, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #219: the one preview card a message with a link may show — title,
 * description and image when the homeserver's `/preview_url` has them. It
 * only ever renders because the viewing member opted in (urlPreviewPrefs.ts
 * decides whether this component is even reached for — see Room.tsx): since
 * building this answer means the homeserver itself fetches the linked page,
 * asking for it is the member's own privacy choice, made once in Settings,
 * never something this card reaches for on its own.
 *
 * Nothing here is an error state: no metadata, a homeserver that won't
 * preview this link, or a failed fetch all render as no card at all — the
 * same quiet miss `SharedFileCard` gives a file it can't load a thumbnail
 * for. The image, when there is one, is fetched the same authenticated way
 * a shared file's thumbnail is (`loadMedia`) — never an `<img src>` pointed
 * straight at whatever the preview returned.
 */
export function LinkPreviewCard({
  url,
  getUrlPreview,
  loadMedia,
}: {
  url: string;
  getUrlPreview: WorkspaceConnection["getUrlPreview"];
  loadMedia: WorkspaceConnection["loadMedia"];
}) {
  const [preview, setPreview] = useState<UrlPreview | null>(null);
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    void getUrlPreview(url).then((result) => {
      if (!cancelled) {
        setPreview(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url, getUrlPreview]);

  useEffect(() => {
    if (!preview?.image) {
      setImage(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void loadMedia(preview.image).then((blob) => {
      if (cancelled || blob === null) {
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setImage(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [preview?.image, loadMedia]);

  if (preview === null || (preview.title === null && preview.description === null && image === null)) {
    return null;
  }

  return (
    <a
      className="mt-2 flex flex-col gap-2 overflow-hidden rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] type-body text-[var(--text)]"
      data-testid="link-preview-card"
      href={url}
      rel="noreferrer noopener"
      target="_blank"
    >
      {image !== null && (
        <img alt="" className="max-h-48 w-full object-cover" data-testid="link-preview-image" src={image} />
      )}
      <div className="flex flex-col gap-1 px-3 pb-3 pt-1">
        {preview.title !== null && (
          <p className="type-body" data-testid="link-preview-title">
            {preview.title}
          </p>
        )}
        {preview.description !== null && (
          <p className="type-provenance text-[var(--muted)]" data-testid="link-preview-description">
            {preview.description}
          </p>
        )}
      </div>
    </a>
  );
}
