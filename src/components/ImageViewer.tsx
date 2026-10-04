import { useState } from "react";
import { Download, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import type { SharedFile } from "../workspace/matrix.js";

/**
 * #218: a shared image, opened full screen from `SharedFileCard`. `src` is
 * exactly the thumbnail's own blob URL — the bytes the member's own
 * authenticated fetch already loaded (#66) — so the viewer never makes a
 * second, unauthenticated request against the raw `mxc://` reference; it
 * just shows the same bytes larger. Zoom is one click: fit-to-screen, or
 * the image at its own size inside a frame the member scrolls (no pinch,
 * no pan gesture — #218 asks for this to stay simple). Escape and the
 * backdrop close it, same as any dialog in this app (the primitive's
 * doing, not this component's). Download reuses the card's own handler —
 * same fetch, same failure handling, same loading state — passed in
 * rather than duplicated here.
 */
export function ImageViewer({
  file,
  src,
  open,
  onOpenChange,
  onDownload,
  downloading,
}: {
  file: SharedFile;
  /** The thumbnail's own object URL — already authenticated, already in hand. */
  src: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The card's own download handler (loadMedia → blob → `<a download>`), shared rather than duplicated. */
  onDownload: () => void;
  downloading: boolean;
}) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setZoomed(false);
        }
      }}
      open={open}
    >
      <DialogContent
        className="inset-0! top-0! max-w-none! gap-0! rounded-none! bg-[var(--bg)]! p-0!"
        data-testid="image-viewer"
      >
        <DialogTitle className="sr-only">{file.name}</DialogTitle>
        <DialogDescription className="sr-only">{file.name}, shown full screen. Escape closes it.</DialogDescription>
        <div className="flex items-center justify-end gap-2 p-2">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-60"
            data-testid="image-viewer-download"
            disabled={downloading}
            onClick={onDownload}
            type="button"
          >
            <Download aria-hidden="true" className="mr-1.5 inline size-4" />
            Download
          </button>
          <DialogClose
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)]"
            data-testid="image-viewer-close"
          >
            <X aria-hidden="true" className="mr-1.5 inline size-4" />
            Close
          </DialogClose>
        </div>
        <div className={`flex min-h-0 flex-1 px-4 pb-4 ${zoomed ? "overflow-auto" : "items-center justify-center overflow-hidden"}`}>
          <button
            aria-label={zoomed ? "Zoom out" : "Zoom in"}
            className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-0"
            data-testid="image-viewer-zoom"
            onClick={() => setZoomed((z) => !z)}
            type="button"
          >
            <img
              alt={file.name}
              className={zoomed ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
              data-testid="image-viewer-image"
              src={src}
            />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
