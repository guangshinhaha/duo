// The build-time settings this app reads (Vite inlines `import.meta.env.VITE_*`).
interface ImportMetaEnv {
  /** The hosted daemon's origin, baked in at build time. Unset ⇒ the app asks for a daemon address on Setup, as it always did. */
  readonly VITE_DUO_DAEMON_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
