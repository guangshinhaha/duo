import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";

/**
 * The tooltip primitive (#34): hover/focus behaviour, the delay, the
 * `role="tooltip"` and `aria-describedby` wiring from Radix; the look from
 * #33 — an entry shape floating above the ground. A tooltip is a label, so
 * its text takes the provenance role; it never carries meaning a visible
 * label doesn't already state (AC3's labelling rule applies to it too).
 */

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export function TooltipContent({ className = "", children, ...props }: ComponentProps<typeof RadixTooltip.Content>) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        className={`z-50 shape-entry px-2 py-1 type-provenance text-[var(--text)] ${className}`}
        {...props}
      >
        {children}
        <RadixTooltip.Arrow className="fill-[var(--surface)]" />
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  );
}
