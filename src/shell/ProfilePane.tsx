import type { DuoApiConfig } from "../api/client.js";
import { pairedHostedAccount } from "../api/hosted.js";
import { useOrgOverview } from "../api/queries.js";
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
 * duo#318: the owner's own verification/answering read — the one place this client tells the owner,
 * rather than an admin, what their duo's state is. Hosted-only; `useOrgOverview` answers `{ none: true }`
 * for a personal duo, or null before the first answer lands, and nothing is shown either way.
 */
function useVerification(api: DuoApiConfig): { verified: boolean; answeringEnabled: boolean } | null {
  const data = useOrgOverview(api, pairedHostedAccount(api) !== null).data;
  return data && !("none" in data) ? data : null;
}

/**
 * The inline label beside "Your duo": "Verified" is quiet and informational, because a deployment
 * with no Google sign-in at all shows every duo unverified by design, and that is not the owner's
 * problem to fix from here — so an unverified owner sees no badge at all rather than a false alarm.
 */
function VerificationBadge({ api }: { api: DuoApiConfig }) {
  const verification = useVerification(api);
  if (!verification?.verified || !verification.answeringEnabled) {
    return null;
  }
  return (
    <span className="type-provenance text-[var(--muted)]" data-testid="profile-verified">
      Verified
    </span>
  );
}

/**
 * The one state that changes what colleagues experience, so — unlike the quiet badge above — it
 * carries the refused tone and an explanation, the same register a demotion or a refusal gets
 * elsewhere in this client, and sits on its own line rather than beside the title.
 */
function AnsweringPausedNotice({ api }: { api: DuoApiConfig }) {
  const verification = useVerification(api);
  if (verification?.answeringEnabled !== false) {
    return null;
  }
  return (
    <p className="type-provenance text-[var(--refused)]" data-testid="profile-answering-paused">
      An admin has paused this duo&apos;s answering. It still works for you — colleagues are told it isn&apos;t answering right now.
    </p>
  );
}

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
            <div className="flex flex-wrap items-baseline gap-2">
              <h1 className="type-heading">Your duo</h1>
              <VerificationBadge api={api} />
            </div>
            <a className="type-provenance text-[var(--muted)] underline" data-testid="profile-back" href="#duo">
              Back to the chat
            </a>
          </div>
        </div>
        <AnsweringPausedNotice api={api} />
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
