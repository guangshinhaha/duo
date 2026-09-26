import type { DuoApiConfig } from "../api/client.js";
import { useMirrorRefusals } from "../api/queries.js";

/**
 * What the owner has told the duo it must never speak for them on, and the
 * reason they gave (#53) — `GET /mirror/refusals`, `duo/refusals.md` verbatim.
 * The daemon's `decided` flag is what tells "never asked" from "asked, and
 * the owner recorded none": an empty list alone cannot. Recording a refusal
 * stays at the terminal (AR-18), so the empty states point there rather than
 * offering a control the daemon has no route for.
 */
export function RefusalsSection({ api }: { api: DuoApiConfig }) {
  const refusals = useMirrorRefusals(api);

  let body: React.ReactNode = null;
  if (refusals.isLoading) {
    body = <div className="text-[var(--muted)]">Loading refusals…</div>;
  } else if (refusals.error) {
    body = <div className="text-[var(--refused)]">{(refusals.error as Error).message}</div>;
  } else if (refusals.data) {
    const { decided, refusals: list } = refusals.data;
    if (!decided) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-undecided">
          What your duo must refuse hasn&apos;t been asked yet. Record refusals in the terminal on your Mac — duo mirror refusals add, or
          duo mirror refusals confirm-none.
        </p>
      );
    } else if (list.length === 0) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-none">
          You reviewed this and recorded none — your duo has no standing refusals.
        </p>
      );
    } else {
      body = (
        <div className="flex flex-col gap-3">
          {list.map((refusal) => (
            <div key={refusal.heading} className="flex flex-col gap-1 shape-entry p-4" data-testid="refusal">
              <h3 className="type-heading" data-testid="refusal-heading">
                {refusal.heading}
              </h3>
              {refusal.reason.length > 0 ? (
                <p className="type-body whitespace-pre-wrap text-[var(--muted)]" data-testid="refusal-reason">
                  {refusal.reason}
                </p>
              ) : (
                <p className="type-provenance text-[var(--faint)]">No reason written.</p>
              )}
            </div>
          ))}
        </div>
      );
    }
  }

  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="refusals">
      <h2 className="type-heading">Refusals{refusals.data && refusals.data.decided ? ` (${refusals.data.refusals.length})` : ""}</h2>
      {body}
    </section>
  );
}
