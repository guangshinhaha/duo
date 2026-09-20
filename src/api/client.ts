import type { ApiError } from "./types.js";

/** Thrown for any non-2xx response, carrying the daemon's own error shape (`client-tech-design.md` §1.5: `{ error: { code, message } }`) so callers can branch on `code` without parsing prose. */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, body: ApiError | undefined) {
    // `body?.error?.`, not `body?.error.` — `body` is only ever cast to
    // `ApiError` (`apiRequest` below does `as ApiError`, an unchecked
    // assertion, not real validation), so a non-2xx response whose JSON
    // doesn't actually follow the {error:{code,message}} contract — an
    // infra 502, or any endpoint that predates it — would otherwise throw
    // a raw TypeError reading `.message` off `undefined` from inside this
    // very constructor, before an ApiRequestError even exists to report.
    super(body?.error?.message ?? `Request failed with status ${status}`);
    this.name = "ApiRequestError";
    this.code = body?.error?.code ?? "unknown";
    this.status = status;
  }
}

export interface DuoApiConfig {
  /** The daemon's base URL, e.g. `http://100.64.1.5:7717`. Never defaults to localhost in production — client-design.md §1.1: the phone reaches the Mac over the tailnet, not loopback. */
  baseUrl: string;
  /** The bearer token minted by `duo pair` for this device. */
  token: string;
}

/**
 * Thrown when a request outlives the timeout its caller set (#27): the
 * daemon was reached but never answered — `POST /drafts` with a real
 * provider can run tens of seconds (§1.4), and a wedged one must end by
 * itself. Deliberately NOT a TypeError: a timeout is not unreachability,
 * and the OfflineBar's "your duo is asleep" wording must never be shown
 * for a duo that was merely slow.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The daemon did not answer within ${Math.round(timeoutMs / 1000)}s. Try asking again.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The one function every API call goes through. No per-resource client
 * class: the daemon's route surface is small and flat, and one function
 * plus `src/api/types.ts`'s types is enough to keep every call fully
 * typed without generating or maintaining a client SDK.
 */
export async function apiRequest<T>(
  config: DuoApiConfig,
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs, signal: callerSignal, ...rest } = init ?? {};
  // One controller both exits write to — the caller's cancel (the
  // Composer's Cancel button) and the timeout — because fetch accepts a
  // single signal. Which exit fired is remembered separately: an abort is
  // the owner's choice and surfaces as a reset, a timeout is the daemon
  // failing to answer and surfaces as one.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort);
    }
  }
  let timedOut = false;
  const timer = timeoutMs !== undefined ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : undefined;

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...rest.headers,
      },
    });

    if (!response.ok) {
      let body: ApiError | undefined;
      try {
        body = (await response.json()) as ApiError;
      } catch {
        body = undefined;
      }
      throw new ApiRequestError(response.status, body);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } catch (error) {
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new RequestTimeoutError(timeoutMs ?? 0);
    }
    throw error; // a TypeError stays a TypeError (unreachable); an owner abort stays an abort
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (callerSignal) {
      callerSignal.removeEventListener("abort", forwardAbort);
    }
  }
}
