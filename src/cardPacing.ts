/**
 * How often your duo may bring something up (docs/design-language.md §5.9:
 * batched attention). Training arrives as cards in its own chat, never as a
 * stream of pings, so a card the owner sets aside stays aside: a rules card
 * for the rest of the day, the weekly digest for the rest of the week. This
 * is a courtesy of this device, so it lives in this browser's storage and is
 * allowed to be lost — a lost setting means a card shows again, never that a
 * decision is missing.
 */

const KEY = "duo.card-pacing";

function read(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // no storage: the card simply shows again next time
  }
}

/** The local calendar day, `YYYY-MM-DD`. */
export function dayOf(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The week a day falls in, named by the Monday that starts it — so "this week" is stable from Monday to Sunday. */
export function weekOf(now: Date = new Date()): string {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return dayOf(monday);
}

export type PacingPeriod = "day" | "week";

const stamp = (period: PacingPeriod, now: Date): string => (period === "day" ? dayOf(now) : weekOf(now));

/** Sets a card aside for the rest of the day or week. */
export function setAside(card: string, period: PacingPeriod, now: Date = new Date()): void {
  write({ ...read(), [card]: `${period}:${stamp(period, now)}` });
}

/** Whether a card was set aside and the day or week it was set aside for is still the current one. */
export function isSetAside(card: string, now: Date = new Date()): boolean {
  const value = read()[card];
  if (value === undefined) {
    return false;
  }
  const [period, when] = value.split(/:(.*)/s) as [PacingPeriod, string];
  return (period === "day" || period === "week") && when === stamp(period, now);
}

/** Forgets everything set aside — used when a duo is unpaired, so the next one starts fresh. */
export function clearPacing(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
