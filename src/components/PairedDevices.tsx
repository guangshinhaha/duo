import type { DuoApiConfig } from "../api/client.js";
import { useDevices, useRevokeDevice } from "../api/queries.js";
import type { PairedDevice } from "../api/types.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./primitives/AlertDialog.js";
import { MutationError } from "./MutationError.js";
import { Timestamp } from "./Timestamp.js";

const rowButton = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]";

/** The consequence, first (#48 AC4) — for the device being used it is this app's own end, in the daemon's terms; for any other it is that device's. Re-pairing is `duo pair new` at the Mac either way: pairing stays a physical act there. */
function revokeCopy(device: PairedDevice, isThis: boolean): { title: string; description: string; confirm: string } {
  if (isThis) {
    return {
      title: "Revoke this device?",
      description:
        "This is the device you're using. Revoking it ends its access to your duo right now, and this app returns to Setup. To pair it again, run duo pair new on your Mac.",
      confirm: "Revoke this device",
    };
  }
  return {
    title: `Revoke ${device.name}?`,
    description: `${device.name} loses access to your duo immediately, and its open connection closes. To pair it again, run duo pair new on your Mac.`,
    confirm: `Revoke ${device.name}`,
  };
}

function DeviceRow({
  device,
  isThis,
  marked,
  onMark,
  onUnmark,
  onRevoke,
}: {
  device: PairedDevice;
  isThis: boolean;
  /** Whether this device knows which row it is at all — until it does, every live row offers to be the one. */
  marked: boolean;
  onMark: () => void;
  onUnmark: () => void;
  onRevoke: () => void;
}) {
  const copy = revokeCopy(device, isThis);
  return (
    <li className="shape-entry flex flex-col gap-2 px-4 py-3" data-testid="device-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body" data-testid="device-name">
          {device.name}
        </span>
        {isThis && (
          <span className="rounded-[var(--r-sm)] border border-[var(--edge)] px-2 py-0 type-provenance text-[var(--text)]" data-testid="device-this">
            This device
          </span>
        )}
        {device.revokedAt && (
          <span className="type-provenance text-[var(--refused)]" data-testid="device-revoked">
            Revoked <Timestamp iso={device.revokedAt} />
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 type-provenance text-[var(--muted)]">
        <span data-testid="device-paired">
          Paired <Timestamp iso={device.createdAt} />
        </span>
        <span data-testid="device-last-seen">Last seen {device.lastSeenAt ? <Timestamp iso={device.lastSeenAt} /> : "never"}</span>
      </div>
      {!device.revokedAt && (
        <div className="flex flex-wrap gap-2">
          {/* #34's confirmation primitive, as the Forget flow uses it: focus
              trap, Escape-equals-Cancel, and a stray click is not an answer. */}
          <AlertDialog>
            <AlertDialogTrigger aria-label={`Revoke ${device.name}…`} className={rowButton} data-testid="device-revoke">
              Revoke…
            </AlertDialogTrigger>
            <AlertDialogContent className="w-[calc(100vw-3rem)] max-w-md" data-testid="device-revoke-confirmation">
              <AlertDialogTitle className="type-heading">{copy.title}</AlertDialogTitle>
              <AlertDialogDescription className="type-provenance text-[var(--muted)]" data-testid="device-revoke-description">
                {copy.description}
              </AlertDialogDescription>
              <div className="flex gap-2">
                <AlertDialogAction
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white"
                  data-testid="device-revoke-confirm"
                  onClick={onRevoke}
                >
                  {copy.confirm}
                </AlertDialogAction>
                <AlertDialogCancel
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                  data-testid="device-revoke-cancel"
                >
                  Cancel
                </AlertDialogCancel>
              </div>
            </AlertDialogContent>
          </AlertDialog>
          {!marked && (
            <button className={rowButton} data-testid="device-mark" onClick={onMark} type="button">
              This is this device
            </button>
          )}
          {isThis && (
            <button className={rowButton} data-testid="device-unmark" onClick={onUnmark} type="button">
              Not this device
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * #48: which devices can read this corpus, and the one act on that list —
 * cutting one off. The list is the daemon's own (`GET /devices`, digital-duo
 * #177): name, when paired, when last seen, never a token (the shape has no
 * field that could carry one). Revoking is `POST /devices/:id/revoke`, and
 * the daemon does all of it — the token stops authenticating and that
 * device's socket closes; this surface asks first and shows the answer.
 *
 * "This device" is the one thing the daemon cannot tell a caller (no route
 * says which row is the caller), so it is a client-local mark: the owner
 * points at their own row once, `DuoApiConfig.deviceId` remembers it beside
 * the pairing, and until then the list says so instead of guessing. Revoking
 * the marked device is the deliberate case — the consequence is stated
 * first, the daemon is asked first, and only its yes hands the app back to
 * Setup through the one unpair choke point (`onConfigChange(null)`); a
 * refusal leaves the pairing standing, because the token still works.
 *
 * Pairing a new device is not here: it stays an act at the machine holding
 * the corpus.
 */
export function PairedDevices({ api, onConfigChange }: { api: DuoApiConfig; onConfigChange: (config: DuoApiConfig | null) => void }) {
  const { data: devices, isLoading, error, refetch } = useDevices(api);
  const revoke = useRevokeDevice(api);
  const marked = api.deviceId !== undefined;

  // Live devices first — they are the ones that can read the corpus right now.
  const ordered = Array.isArray(devices) ? [...devices].sort((a, b) => Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt))) : [];

  function revokeDevice(device: PairedDevice): void {
    revoke.reset();
    revoke.mutate(
      { id: device.id },
      {
        // Revoked first, forgotten second: only the daemon's yes ends this
        // device's own pairing, so a refusal never strands it half-way.
        onSuccess: () => {
          if (device.id === api.deviceId) {
            onConfigChange(null);
          }
        },
      },
    );
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-devices">
      <h2 className="type-heading">Devices</h2>
      <p className="type-provenance text-[var(--muted)]">
        The devices paired with your duo. To pair a new one, run <code>duo pair new</code> on your Mac.
      </p>
      {isLoading ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="devices-loading" role="status">
          Loading devices…
        </p>
      ) : error ? (
        <div className="flex flex-col gap-2" data-testid="devices-error" role="alert">
          <p className="type-provenance text-[var(--refused)]">{error instanceof Error ? error.message : "The daemon could not list its devices."}</p>
          <button className={`${rowButton} self-start`} onClick={() => void refetch()} type="button">
            Try again
          </button>
        </div>
      ) : ordered.length === 0 ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="devices-empty">
          No paired devices.
        </p>
      ) : (
        <>
          {!marked && (
            <p className="type-provenance text-[var(--muted)]" data-testid="devices-unmarked-note">
              Your duo doesn't say which of these is this device. Mark it once, and revoking it will be a deliberate act rather than a guess.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {ordered.map((device) => (
              <DeviceRow
                device={device}
                isThis={device.id === api.deviceId}
                key={device.id}
                marked={marked}
                onMark={() => onConfigChange({ ...api, deviceId: device.id })}
                onRevoke={() => revokeDevice(device)}
                onUnmark={() => onConfigChange({ baseUrl: api.baseUrl, token: api.token })}
              />
            ))}
          </ul>
        </>
      )}
      {revoke.isPending && (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Revoking…
        </p>
      )}
      <MutationError error={revoke.error} />
    </section>
  );
}
