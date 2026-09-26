/**
 * #129: the navigation's map, as data. The sidebar and the phone's folded
 * navigation both render this one structure, so moving a screen to another
 * section, renaming a section, or rewording its explainer is an edit here
 * and nowhere else.
 *
 * The three sections are the three things a person does in the app, in the
 * words a newcomer would use for them: talking with people, their duo
 * answering people for them, and training their duo. Settings belongs to
 * none of them — it is the app's own upkeep, so it stands apart, below.
 *
 * Copy rules for anything in this file (`docs/vocabulary.md`): plain words,
 * no infrastructure names ("workspace", "homeserver" and the protocol under
 * it stay out of visible strings), and the duo is always "your duo" —
 * attributed, never a person or a colleague. A test holds both.
 */

/** What a section needs before it has anything to show: a signed-in conversation account, or a paired duo. */
export type NavNeeds = "conversations" | "duo";

/** A count a screen's entry carries, so a count has one home whichever section the screen sits in. */
export type NavBadge = "drafts" | "confirmations";

export interface NavScreen {
  /** The screen's own address — also what lights the entry (see `activeNavHref` in App). */
  href: string;
  label: string;
  badge?: NavBadge;
}

export interface NavSection {
  id: "people" | "answering" | "training";
  title: string;
  /** One line under the title: what this part of the app is for. */
  explainer: string;
  needs: NavNeeds;
  /** Shown instead of the screens while `needs` isn't met — a note, never a form. */
  notSetUp: string;
  /** Where the note points, when there is somewhere to set it up. */
  setUp?: { label: string; href: string };
  screens: readonly NavScreen[];
}

/** Sections render in this order; screens render in theirs. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "people",
    title: "Talking to people",
    explainer: "Conversations with the people you work with.",
    needs: "conversations",
    notSetUp: "Not set up yet.",
    setUp: { label: "Set up in Settings", href: "#settings" },
    screens: [{ href: "#conversations", label: "Conversations" }],
  },
  {
    id: "answering",
    title: "Your duo answering others",
    explainer: "What it answered, passed on to you, or declined for others.",
    needs: "duo",
    notSetUp: "Not set up yet. It needs a duo.",
    screens: [
      { href: "#audit", label: "Audit" },
      { href: "#escalations", label: "Escalations" },
      { href: "#channels", label: "Channels" },
    ],
  },
  {
    id: "training",
    title: "Training your duo",
    explainer: "Review its drafts and teach it how you answer.",
    needs: "duo",
    notSetUp: "Not set up yet. It needs a duo.",
    screens: [
      { href: "#review", label: "Review", badge: "drafts" },
      { href: "#confirmations", label: "Confirmations", badge: "confirmations" },
      { href: "#corrections", label: "Corrections" },
      { href: "#duo", label: "Duo" },
      { href: "#trust", label: "Trust" },
      { href: "#mirror", label: "Mirror" },
      { href: "#knowledge", label: "Knowledge" },
    ],
  },
];

/** Outside every section on purpose: the app's own upkeep, not one of the three things you do in it. */
export const SETTINGS_SCREEN: NavScreen = { href: "#settings", label: "Settings" };
