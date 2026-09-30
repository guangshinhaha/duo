import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";

/**
 * The menu primitive (#34): open/close on click, type-ahead, roving arrows,
 * `role="menu"`/`menuitem` and Escape-to-close from Radix; the look from
 * #33 — a container panel of quiet entries. Items highlight with the
 * second surface, the one token that already means "raised above the
 * ground" without meaning action (that stays the accent's alone).
 */

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;

export function DropdownMenuContent({ className = "", children, ...props }: ComponentProps<typeof RadixDropdownMenu.Content>) {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content className={`z-50 flex min-w-40 flex-col gap-1 p-2 shape-container motion-menu ${className}`} {...props}>
        {children}
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
}

export function DropdownMenuItem({ className = "", ...props }: ComponentProps<typeof RadixDropdownMenu.Item>) {
  return (
    <RadixDropdownMenu.Item
      className={`flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 type-body text-[var(--text)] data-highlighted:bg-[var(--surface-2)] ${className}`}
      {...props}
    />
  );
}
