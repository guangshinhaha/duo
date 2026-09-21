import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";

/**
 * The confirmation primitive (#34) — the same contract as `Dialog`
 * (behaviour and accessibility from Radix, look from #33's tokens) for the
 * one case that must not be dismissable by a stray click: a destructive
 * confirmation. Radix's AlertDialog ignores outside pointer-downs and
 * requires an explicit Action or Cancel; the panel is the same
 * `shape-container` scaffold as every dialog.
 */

const panelClass = "fixed inset-x-0 top-6 z-50 mx-auto flex flex-col gap-3 p-4 shape-container";

export const AlertDialog = RadixAlertDialog.Root;
export const AlertDialogTrigger = RadixAlertDialog.Trigger;
export const AlertDialogAction = RadixAlertDialog.Action;
export const AlertDialogCancel = RadixAlertDialog.Cancel;
export const AlertDialogTitle = RadixAlertDialog.Title;
export const AlertDialogDescription = RadixAlertDialog.Description;

/**
 * Portal + scrim + panel, matching `DialogContent`'s one-element contract.
 * Title and Description are Radix's own parts (not re-styled here) because
 * their job is the accessibility wiring — an alert dialog is announced by
 * them — and the caller styles them from the type roles like any text.
 */
export function AlertDialogContent({ className = "", children, ...props }: ComponentProps<typeof RadixAlertDialog.Content>) {
  return (
    <RadixAlertDialog.Portal>
      <RadixAlertDialog.Overlay className="fixed inset-0 z-50 bg-[var(--bg)]/80" />
      <RadixAlertDialog.Content className={`${panelClass} ${className}`} {...props}>
        {children}
      </RadixAlertDialog.Content>
    </RadixAlertDialog.Portal>
  );
}
