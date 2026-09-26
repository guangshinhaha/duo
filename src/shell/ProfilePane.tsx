import type { DuoApiConfig } from "../api/client.js";
import { Mark } from "../components/Mark.js";
import { Activity } from "../profile/Activity.js";
import { Knows } from "../profile/Knows.js";
import { MayDo } from "../profile/MayDo.js";
import { Portrait } from "../profile/Portrait.js";
import { Rules } from "../profile/Rules.js";
import { PROFILE_TABS, type ProfileTab } from "./routes.js";

const LABELS: Readonly<Record<ProfileTab, string>> = {
  portrait: "Portrait",
  knows: "Knows",
  may: "May do",
  rules: "Rules",
  activity: "Activity",
};

/**
 * The duo's profile — what you open by tapping its name (docs/design-language.md
 * §6.2). Five tabs, in an owner's words: Portrait (who it thinks you are),
 * Knows (what it has read and where it listens), May do (what it handles on
 * its own), Rules (your standing orders and what they came from) and Activity
 * (what it did for others, and where it runs out). It is where you understand
 * the duo, never where you must go to use it: everything here is also how
 * training reaches you in its chat, and none of it is required.
 */
export function ProfilePane({ api, tab }: { api: DuoApiConfig; tab: ProfileTab }) {
  return (
    <div className="flex flex-col" data-testid="profile-pane">
      <header className="sticky top-0 z-10 border-b border-[var(--edge)] bg-[var(--bg)] px-4 pt-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)]">
            <Mark />
          </span>
          <div className="flex min-w-0 flex-col">
            <h1 className="type-heading">Your duo</h1>
            <a className="type-provenance text-[var(--muted)] underline" data-testid="profile-back" href="#duo">
              Back to the chat
            </a>
          </div>
        </div>
        <nav aria-label="Profile" className="-mb-px mt-2 flex gap-1 overflow-x-auto">
          {PROFILE_TABS.map((name) => (
            <a
              aria-current={name === tab ? "page" : undefined}
              className={`inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 type-body ${
                name === tab ? "border-[var(--text)] text-[var(--text)]" : "border-transparent text-[var(--muted)]"
              }`}
              data-testid={`profile-tab-${name}`}
              href={name === "portrait" ? "#duo/profile" : `#duo/profile/${name}`}
              key={name}
            >
              {LABELS[name]}
            </a>
          ))}
        </nav>
      </header>
      <div data-testid={`profile-${tab}`}>
        {tab === "portrait" && <Portrait api={api} />}
        {tab === "knows" && <Knows api={api} />}
        {tab === "may" && <MayDo api={api} />}
        {tab === "rules" && <Rules api={api} />}
        {tab === "activity" && <Activity api={api} />}
      </div>
    </div>
  );
}
