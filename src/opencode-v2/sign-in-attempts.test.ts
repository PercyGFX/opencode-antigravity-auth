import { describe, expect, it, vi } from "vitest";

import { createSignInAttempts, type SignInAuthorization } from "./sign-in-attempts";

interface Result {
  email: string;
}

const deferred = () => {
  let resolve!: (value: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSignInAttempts", () => {
  it("tracks a browser sign-in until the browser reports back", async () => {
    const browser = deferred();
    const onComplete = vi.fn();
    const start = vi.fn(async (_hint?: string): Promise<SignInAuthorization<Result>> => ({
      mode: "auto",
      url: "https://accounts.google.com/x",
      instructions: "Open it",
      callback: browser.promise,
    }));
    const signIns = createSignInAttempts({ start, emailOf: (result: Result) => result.email, onComplete });

    const attempt = await signIns.start("me@gmail.com");
    expect(start).toHaveBeenCalledWith("me@gmail.com");
    expect(attempt).toMatchObject({ mode: "auto", url: "https://accounts.google.com/x", instructions: "Open it" });
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "pending" });

    browser.resolve({ email: "me@gmail.com" });
    await flush();
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "complete", email: "me@gmail.com" });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("reports a failed browser sign-in", async () => {
    const browser = deferred();
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "auto", url: "u", instructions: "i", callback: browser.promise }),
      emailOf: (result: Result) => result.email,
    });
    const attempt = await signIns.start();
    browser.reject(new Error("access_denied"));
    await flush();
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "failed", message: "access_denied" });
  });

  it("completes a paste sign-in with the redirect URL", async () => {
    const callback = vi.fn(async (code: string) => ({ email: `${code}@gmail.com` }));
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "code", url: "u", instructions: "i", callback }),
      emailOf: (result: Result) => result.email,
    });
    const attempt = await signIns.start();
    await expect(signIns.complete(attempt.attemptID, "pasted")).resolves.toEqual({ email: "pasted@gmail.com" });
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "complete", email: "pasted@gmail.com" });
  });

  it("refuses to complete unknown or browser attempts", async () => {
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "auto", url: "u", instructions: "i", callback: deferred().promise }),
      emailOf: (result: Result) => result.email,
    });
    const attempt = await signIns.start();
    await expect(signIns.complete(attempt.attemptID, "code")).rejects.toThrow("expired");
    await expect(signIns.complete("missing", "code")).rejects.toThrow("expired");
  });

  it("expires attempts after 10 minutes", async () => {
    let now = 1_000;
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "auto", url: "u", instructions: "i", callback: deferred().promise }),
      emailOf: (result: Result) => result.email,
      now: () => now,
    });
    const attempt = await signIns.start();
    now += 10 * 60 * 1000 + 1;
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "expired" });
  });

  it("cancels a waiting browser sign-in and frees the callback port", async () => {
    const onCancel = vi.fn();
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "auto", url: "u", instructions: "i", callback: deferred().promise }),
      emailOf: (result: Result) => result.email,
      onCancel,
    });
    const attempt = await signIns.start();
    await signIns.cancel(attempt.attemptID);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "expired" });
  });
});

describe("browser sign-in paste fallback", () => {
  it("finishes a browser sign-in with a pasted URL, and the closing listener can't undo it", async () => {
    const browser = deferred();
    const paste = vi.fn(async (code: string) => ({ email: `${code}@gmail.com` }));
    const signIns = createSignInAttempts({
      start: async () => ({ mode: "auto", url: "u", instructions: "i", callback: browser.promise, paste }),
      emailOf: (result: Result) => result.email,
    });
    const attempt = await signIns.start();

    await expect(signIns.complete(attempt.attemptID, "pasted")).resolves.toEqual({ email: "pasted@gmail.com" });
    // Pasting closes the listener, which rejects the browser callback afterwards.
    browser.reject(new Error("OAuth listener closed before callback"));
    await flush();
    expect(signIns.status(attempt.attemptID)).toEqual({ status: "complete", email: "pasted@gmail.com" });
  });
});
