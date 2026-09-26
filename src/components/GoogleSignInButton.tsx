import { useEffect, useRef, useState } from "react";

/**
 * The slice of Google Identity Services (`accounts.google.com/gsi/client`)
 * this app uses: initialize with our client id and a callback, render the
 * official button. Declared by hand — the library is a script tag, not an
 * npm dependency — and feature-detected, so a test can install a fake
 * `window.google` and a plain build never imports anything.
 */
interface GoogleCredentialResponse {
  readonly credential: string;
}

interface GoogleAccountsId {
  initialize(options: { client_id: string; callback: (response: GoogleCredentialResponse) => void; ux_mode?: "popup" }): void;
  renderButton(parent: HTMLElement, options: { theme?: string; size?: string; text?: string; shape?: string; width?: number }): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleAccountsId> | undefined;

/** Loads the GIS script once per page; resolves as soon as `window.google.accounts.id` exists (immediately, when a test put it there). */
function loadGoogleIdentity(): Promise<GoogleAccountsId> {
  const present = window.google?.accounts?.id;
  if (present) {
    return Promise.resolve(present);
  }
  loading ??= new Promise<GoogleAccountsId>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => {
      const id = window.google?.accounts?.id;
      if (id) {
        resolve(id);
      } else {
        loading = undefined;
        reject(new Error("Google sign-in loaded but isn't available."));
      }
    };
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Couldn't load Google sign-in."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Google's own "Sign in with Google" button. Hands its ID token to
 * `onCredential` — the caller sends it to the daemon, which verifies it;
 * this component never inspects it.
 */
export function GoogleSignInButton({
  clientId,
  onCredential,
  text = "signin_with",
}: {
  clientId: string;
  onCredential: (credential: string) => void;
  /** GIS's own label choices: "signin_with" ("Sign in with Google") or "continue_with" ("Continue with Google"). */
  text?: "signin_with" | "continue_with";
}) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGoogleIdentity()
      .then((id) => {
        if (cancelled || !container.current) {
          return;
        }
        id.initialize({ client_id: clientId, callback: (response) => callback.current(response.credential), ux_mode: "popup" });
        container.current.replaceChildren();
        id.renderButton(container.current, { theme: "outline", size: "large", text, shape: "rectangular", width: 280 });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFailed(error instanceof Error ? error.message : "Couldn't load Google sign-in.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, text]);

  return (
    <div className="flex flex-col gap-2">
      <div className="min-h-11" data-testid="google-sign-in" ref={container} />
      {failed && (
        <p className="type-body text-[var(--refused)]" data-testid="google-sign-in-failed" role="status">
          {failed} Check your connection, or that a blocker isn&apos;t stopping accounts.google.com, then reload.
        </p>
      )}
    </div>
  );
}
