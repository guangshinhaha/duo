import type { DuoApiConfig } from "../api/client.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { PairDuoForm } from "./PairDuoForm.js";

/**
 * #62: the pairing offer, as an overlay — what "Pair your duo" opens from
 * the member shell's explanation surfaces. The form is the same component
 * the front door renders, so the two doors cannot drift; declining closes
 * and leaves the member exactly where they were (pairing is offered, never
 * demanded).
 */
export function PairDuoDialog({
  open,
  onOpenChange,
  onConnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (config: DuoApiConfig) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="pair-duo-dialog">
        <DialogTitle className="type-heading">Pair your duo</DialogTitle>
        <DialogDescription className="sr-only">Connect this device to your own duo daemon.</DialogDescription>
        <div className="flex flex-col gap-3">
          <p className="type-body text-[var(--muted)]">
            Run <code>duo pair new &quot;this device&apos;s name&quot;</code> on your Mac, then paste its address and token here.
          </p>
          <PairDuoForm onConnect={onConnect} />
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)]"
            onClick={() => onOpenChange(false)}
          >
            Not now
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
