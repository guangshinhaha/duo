import * as RadixDialog from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";

/**
 * The dialog primitive (#34) — §1.2's "take the component layer, not the
 * product". Radix supplies the behaviour and the accessibility (portal,
 * focus trap, Escape, `role="dialog"`/`aria-modal`, backdrop dismissal);
 * this wrapper supplies the look, entirely from #33's system: the panel IS
 * a `shape-container` on the ground, dimmed by the ground itself. Width is
 * the caller's decision (`className`) because it is layout, not identity —
 * every colour, radius, type role and spacing step comes from the tokens.
 */

/** The scrim both dialog kinds share: the ground at 80%, over everything. */
export function DialogOverlay({ className = "" }: { className?: string }) {
  return <RadixDialog.Overlay className={`fixed inset-0 z-50 bg-[var(--bg)]/80 ${className}`} />;
}

/** The shared panel scaffold: fixed near the top, centred, a container in #33's sense. */
const panelClass = "fixed inset-x-0 top-6 z-50 mx-auto flex flex-col gap-3 p-4 shape-container";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogTitle = RadixDialog.Title;
export const DialogDescription = RadixDialog.Description;

/**
 * Portal + scrim + panel in one part, so a consumer composes one element
 * and cannot ship a dialog whose content renders outside the trap (the
 * portal, overlay and focus scope are the primitive's to get right).
 */
export function DialogContent({ className = "", children, ...props }: ComponentProps<typeof RadixDialog.Content>) {
  return (
    <RadixDialog.Portal>
      <DialogOverlay />
      <RadixDialog.Content className={`${panelClass} ${className}`} {...props}>
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
