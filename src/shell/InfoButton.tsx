import { Info } from "lucide-react";
import { useInfoPanel } from "./InspectorContext.js";

/** The chat header's way into the Info panel (#184). Absent where there is no room for the panel or nothing to show. */
export function InfoButton() {
  const info = useInfoPanel();
  if (!info.available) {
    return null;
  }
  return (
    <button
      aria-label={info.open ? "Hide info (⌘I)" : "Show info (⌘I)"}
      aria-pressed={info.open}
      className={`ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] border ${info.open ? "border-[var(--edge)] bg-[var(--surface-2)] text-[var(--text)]" : "border-transparent text-[var(--muted)]"}`}
      data-testid="info-toggle"
      onClick={info.toggle}
      type="button"
    >
      <Info aria-label={info.open ? "Hide info" : "Show info"} size={18} />
    </button>
  );
}
