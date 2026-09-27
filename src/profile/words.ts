import type { AutonomyLevel, TrustTier } from "../api/types.js";

/**
 * What a level and a tier are called on daily surfaces (vocabulary.md, "the
 * three levels, in plain words"). The daemon's codes — T0–T3, ask/approve/
 * auto, earned/granted, stale — stay in detail views and the audit record;
 * they are the system talking to itself, and an owner should never need a
 * design doc to read what their duo may do.
 */
export const LEVEL_WORDS: Readonly<Record<AutonomyLevel, string>> = {
  ask: "Always asks you",
  approve: "Drafts for you",
  auto: "Answers on its own",
};

/** The kind of thing a tier covers, as an owner would say it. */
export const TIER_WORDS: Readonly<Record<TrustTier, string>> = {
  T0: "answering questions",
  T1: "drafting replies",
  T2: "reversible actions",
  T3: "binding actions",
};

/** The tiers a person may grant, in the words they'd pick between. T4 is absent on purpose: there is no such choice to make (AR-17). */
export const GRANTABLE: ReadonlyArray<{ tier: TrustTier; label: string }> = [
  { tier: "T0", label: "answer questions" },
  { tier: "T1", label: "draft replies" },
  { tier: "T2", label: "do reversible things" },
  { tier: "T3", label: "do binding things" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Today", "Yesterday", the weekday within the last week, else the date — the age is the useful fact, not the second. */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(when)) / DAY_MS);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  return days < 7 ? when.toLocaleDateString(undefined, { weekday: "long" }) : when.toLocaleDateString();
}

/**
 * Who asked, in a person's terms: the daemon's asker reference is
 * `kind:name` (`colleague:Rae`, `stranger:link`). The name is the person; a
 * link with no name is "someone with your link". The raw reference is kept for
 * the detail view.
 */
export function plainAsker(ref: string, resolved: boolean): string {
  const [kind, ...rest] = ref.split(":");
  const name = rest.join(":").trim();
  return resolved && kind !== "stranger" && name !== "" && name !== "link" ? name : "Someone with your link";
}
