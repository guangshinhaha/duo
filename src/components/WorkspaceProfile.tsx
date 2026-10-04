import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkspaceConnection } from "../workspace/matrix.js";
import { formatBytes, isImageType, SHARE_IMAGE_LIMIT_BYTES, shareRefusalOf, stageFile } from "../workspace/sharing.js";

/**
 * #224: the member's own name and picture, set here and read everywhere —
 * Matrix folds a profile change into every room's member state on its own
 * (verified against this app's Synapse: AC2 below), so nothing here writes
 * to a room directly. The homeserver's own answer (`connection.profile()`)
 * is read once on mount and after each save; nothing is cached past that,
 * which is what keeps this screen from ever showing a stale or invented
 * value. Once a member saves either field here, the homeserver's copy is
 * the one a daemon's own provisioning default (digital-duo#272) can no
 * longer speak over — this client writes nothing back on its own, ever, so
 * there is nothing here that could race it.
 */
export function WorkspaceProfile({ connection }: { connection: WorkspaceConnection }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [savedName, setSavedName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [avatarMxc, setAvatarMxc] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = (): void => {
    setLoading(true);
    setLoadError(null);
    connection
      .profile()
      .then((profile) => {
        setSavedName(profile.name);
        setName(profile.name ?? "");
        setAvatarMxc(profile.avatarUrl);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Couldn't load your profile.");
      })
      .finally(() => setLoading(false));
  };

  // Loads once per held connection — a fresh mount (a fresh visit to this
  // section) reads the homeserver's current answer rather than whatever an
  // earlier visit left behind.
  useEffect(load, [connection]);

  // The avatar is an `mxc://` reference, not a URL a browser can show on its
  // own — it is fetched the member's own authenticated way (#66's loadMedia)
  // and held as a local object URL for exactly as long as this section is
  // showing it.
  useEffect(() => {
    if (avatarMxc === null) {
      setAvatarPreview(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void connection.loadMedia(avatarMxc).then((blob) => {
      if (cancelled || blob === null) {
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setAvatarPreview(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [avatarMxc, connection]);

  const saveName = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || nameSaving) {
      return;
    }
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    connection
      .setDisplayName(trimmed)
      .then(() => {
        setSavedName(trimmed);
        setName(trimmed);
        setNameSaved(true);
      })
      .catch((error: unknown) => {
        // The refusal names the reason; the words typed stay typed — a
        // failed save must never hand the member back an empty box.
        setNameError(error instanceof Error ? error.message : "Couldn't save your name.");
      })
      .finally(() => setNameSaving(false));
  };

  const pickAvatar = (files: FileList | null): void => {
    const file = files?.[0];
    if (!file) {
      return;
    }
    setAvatarError(null);
    const refusal = !isImageType(file.type)
      ? `${file.name} isn't a picture — pick an image file.`
      : shareRefusalOf({ name: file.name, size: file.size, mimeType: file.type }, 0);
    if (refusal !== null) {
      setAvatarError(refusal);
      return;
    }
    setAvatarUploading(true);
    void (async () => {
      try {
        const staged = await stageFile(file);
        const mxcUri = await connection.setAvatarUrl(staged);
        setAvatarMxc(mxcUri);
      } catch (error) {
        setAvatarError(error instanceof Error ? error.message : "Couldn't save your picture.");
      } finally {
        setAvatarUploading(false);
      }
    })();
  };

  if (loading) {
    return (
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-profile">
        <h2 className="type-heading">Profile</h2>
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading…
        </p>
      </section>
    );
  }

  if (loadError !== null) {
    return (
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-profile">
        <h2 className="type-heading">Profile</h2>
        <p className="type-provenance text-[var(--refused)]" data-testid="profile-load-error" role="status">
          {loadError}
        </p>
        <div>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
            onClick={load}
            type="button"
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="shape-container flex flex-col gap-4 p-4" data-testid="settings-profile">
      <h2 className="type-heading">Profile</h2>
      <p className="type-provenance text-[var(--muted)]">
        Your own name and picture in this workspace — colleagues see them in every conversation you're in.
      </p>

      <form className="flex flex-col gap-2" onSubmit={saveName}>
        <label className="type-provenance text-[var(--muted)]" htmlFor="profile-name-input">
          Display name
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
            data-testid="profile-name-input"
            id="profile-name-input"
            onChange={(e) => {
              setName(e.target.value);
              setNameSaved(false);
            }}
            value={name}
          />
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            data-testid="profile-name-save"
            disabled={nameSaving || name.trim() === "" || name.trim() === (savedName ?? "")}
            type="submit"
          >
            {nameSaving ? "Saving…" : "Save"}
          </button>
        </div>
        {nameError !== null && (
          <p className="type-provenance text-[var(--refused)]" data-testid="profile-name-error" role="status">
            {nameError}
          </p>
        )}
        {nameSaved && nameError === null && (
          <p className="type-provenance text-[var(--muted)]" data-testid="profile-name-saved" role="status">
            Saved.
          </p>
        )}
      </form>

      <div className="flex flex-col gap-2">
        <span className="type-provenance text-[var(--muted)]">Picture</span>
        <div className="flex items-center gap-3">
          {avatarPreview !== null ? (
            <img
              alt="Your picture"
              className="size-12 shrink-0 rounded-[var(--r-md)] border border-[var(--edge)] object-cover"
              data-testid="profile-avatar-preview"
              src={avatarPreview}
            />
          ) : (
            <span
              aria-hidden="true"
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--muted)]"
              data-testid="profile-avatar-placeholder"
            >
              {(savedName ?? "").trim().slice(0, 1).toUpperCase() || "?"}
            </span>
          )}
          <input
            aria-label="Choose a picture"
            accept="image/*"
            className="sr-only"
            data-testid="profile-avatar-input"
            onChange={(e) => {
              pickAvatar(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
            ref={fileInput}
            type="file"
          />
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)] disabled:opacity-40"
            data-testid="profile-avatar-change"
            disabled={avatarUploading}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            {avatarUploading ? "Uploading…" : avatarPreview !== null ? "Change picture" : "Add a picture"}
          </button>
        </div>
        <p className="type-provenance text-[var(--muted)]">An image, up to {formatBytes(SHARE_IMAGE_LIMIT_BYTES)}.</p>
        {avatarError !== null && (
          <p className="type-provenance text-[var(--refused)]" data-testid="profile-avatar-error" role="status">
            {avatarError}
          </p>
        )}
      </div>
    </section>
  );
}
