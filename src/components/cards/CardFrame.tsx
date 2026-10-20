import type { ReactNode } from "react";

/**
 * W-S4-8: the shared shell every `duo.card` kind draws inside — a title,
 * up to a few lines of fixed or daemon-worded copy, and a slot for
 * whatever that kind adds beneath it (a task's milestones, a decision's
 * options). It renders inside `RoomDuoMessage`'s own attributed block
 * (AR-13): no avatar prop exists here, and none should ever be added — the
 * attribution is `RoomDuoMessage`'s alone, this frame only lays out the
 * card's own content beneath it.
 *
 * `chip` sits beside the title — a card's own state, in text (never colour
 * alone, for a member who can't tell them apart by colour).
 */
export function CardFrame({ title, chip, lines, children }: { title: string; chip: ReactNode; lines: readonly string[]; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3" data-testid="duo-card">
      <div className="flex items-center justify-between gap-2">
        <p className="type-heading" data-testid="duo-card-title">
          {title}
        </p>
        {chip}
      </div>
      {lines.length > 0 && (
        <div className="flex flex-col gap-1 type-body text-[var(--text)]" data-testid="duo-card-lines">
          {lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

/** W-S4-8: a card's state, in text — never colour alone (accessibility; every chip here carries its own label, colour is decoration on top of it, not instead of it). */
export function StateChip({ label, tone }: { label: string; tone: "neutral" | "progress" | "signal" | "done" | "failed" }) {
  const toneClass =
    tone === "done"
      ? "text-[var(--confident)]"
      : tone === "failed"
        ? "text-[var(--refused)]"
        : tone === "signal"
          ? "text-[var(--accent)]"
          : tone === "progress"
            ? "text-[var(--escalate)]"
            : "text-[var(--muted)]";
  return (
    <span className={`shrink-0 type-provenance ${toneClass}`} data-testid="duo-card-chip">
      {label}
    </span>
  );
}
