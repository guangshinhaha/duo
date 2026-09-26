import type { DuoApiConfig } from "../api/client.js";
import { Audit } from "../routes/Audit.js";
import { Channels } from "../routes/Channels.js";
import { Corrections } from "../routes/Corrections.js";
import { Escalations } from "../routes/Escalations.js";
import { Knowledge } from "../routes/Knowledge.js";
import { Mirror } from "../routes/Mirror.js";
import { Trust } from "../routes/Trust.js";
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
 * §6.2). Five tabs: Portrait (who it thinks you are), Knows (what it has
 * read), May do (what it handles on its own), Rules (your standing orders),
 * Activity (what it answered, passed on or refused, and where it runs out).
 *
 * In this cut each tab hosts the screen that held its content before the
 * chat-first move — Mirror, Knowledge and Channels, Trust, Corrections, Audit
 * and Escalations — so nothing the owner could reach is unreachable while the
 * profile's own plain-language views (#146) are built.
 */
export function ProfilePane({ api, tab }: { api: DuoApiConfig; tab: ProfileTab }) {
  return (
    <div className="flex flex-col" data-testid="profile-pane">
      <header className="sticky top-0 z-10 border-b border-[var(--edge)] bg-[var(--bg)] px-4 pt-4">
        <h1 className="type-heading">Your duo</h1>
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
        {tab === "portrait" && <Mirror api={api} />}
        {tab === "knows" && (
          <>
            <Knowledge api={api} />
            <Channels api={api} />
          </>
        )}
        {tab === "may" && <Trust api={api} />}
        {tab === "rules" && <Corrections api={api} />}
        {tab === "activity" && (
          <>
            <Audit api={api} />
            <Escalations api={api} />
          </>
        )}
      </div>
    </div>
  );
}
