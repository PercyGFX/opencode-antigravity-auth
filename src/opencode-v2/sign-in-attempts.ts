import { randomUUID } from "node:crypto";

/** What the plugin's browser or paste sign-in returns (the shape opencode's OAuth methods use). */
export type SignInAuthorization<Result> =
  | {
      mode: "auto";
      url: string;
      instructions: string;
      callback: Promise<Result>;
      /** Finishes with a pasted redirect URL when the browser could not reach the callback page. */
      paste?: (code: string) => Promise<Result>;
    }
  | { mode: "code"; url: string; instructions: string; callback: (code: string) => Promise<Result> };

export type SignInStatus =
  | { status: "pending" }
  | { status: "complete"; email?: string }
  | { status: "failed"; message: string }
  | { status: "expired" };

export interface SignInStart {
  attemptID: string;
  mode: "auto" | "code";
  url: string;
  instructions: string;
}

interface Attempt<Result> {
  authorization: SignInAuthorization<Result>;
  status: SignInStatus;
  expiresAt: number;
}

/** Matches opencode's own limit for an unfinished sign-in. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sign-ins the plugin runs itself (re-authenticate / add account from the TUI), outside opencode's
 * integration dialog: they update the plugin's account pool without creating another opencode
 * login. The TUI starts an attempt, then polls it (browser) or completes it with a pasted code.
 */
export function createSignInAttempts<Result>(options: {
  start: (loginHint?: string) => Promise<SignInAuthorization<Result>>;
  emailOf: (result: Result) => string | undefined;
  onComplete?: () => void;
  onCancel?: () => void | Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, Attempt<Result>>();

  const prune = () => {
    for (const [id, attempt] of attempts) {
      if (now() > attempt.expiresAt + ATTEMPT_TTL_MS) attempts.delete(id);
    }
  };

  const settle = (attempt: Attempt<Result>, result: Result) => {
    attempt.status = { status: "complete", email: options.emailOf(result) };
    options.onComplete?.();
    return attempt.status;
  };

  return {
    async start(loginHint?: string): Promise<SignInStart> {
      prune();
      const authorization = await options.start(loginHint);
      const attemptID = randomUUID();
      const attempt: Attempt<Result> = { authorization, status: { status: "pending" }, expiresAt: now() + ATTEMPT_TTL_MS };
      attempts.set(attemptID, attempt);
      if (authorization.mode === "auto") {
        // Only a pending attempt changes: a pasted URL may have finished it first.
        const pending = () => attempts.get(attemptID) === attempt && attempt.status.status === "pending";
        authorization.callback.then(
          (result) => {
            if (pending()) settle(attempt, result);
          },
          (error: unknown) => {
            if (pending()) attempt.status = { status: "failed", message: message(error) };
          },
        );
      }
      return { attemptID, mode: authorization.mode, url: authorization.url, instructions: authorization.instructions };
    },

    status(attemptID: string): SignInStatus {
      const attempt = attempts.get(attemptID);
      if (!attempt) return { status: "expired" };
      if (attempt.status.status === "pending" && now() > attempt.expiresAt) attempt.status = { status: "expired" };
      return attempt.status;
    },

    /** Finishes a sign-in with the pasted redirect URL or code (paste mode, or browser fallback). */
    async complete(attemptID: string, code: string): Promise<{ email?: string }> {
      const attempt = attempts.get(attemptID);
      const finish =
        attempt?.authorization.mode === "code" ? attempt.authorization.callback : attempt?.authorization.paste;
      if (!attempt || !finish || now() > attempt.expiresAt) {
        throw new Error("This sign-in has expired. Start it again.");
      }
      if (attempt.status.status === "complete") {
        return attempt.status.email ? { email: attempt.status.email } : {};
      }
      try {
        const status = settle(attempt, await finish(code));
        return status.status === "complete" && status.email ? { email: status.email } : {};
      } catch (error) {
        attempt.status = { status: "failed", message: message(error) };
        throw error;
      }
    },

    async cancel(attemptID: string): Promise<void> {
      const attempt = attempts.get(attemptID);
      attempts.delete(attemptID);
      if (attempt?.authorization.mode === "auto" && attempt.status.status === "pending") await options.onCancel?.();
    },
  };
}
