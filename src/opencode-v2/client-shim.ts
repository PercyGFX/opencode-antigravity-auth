import { createLogger } from "../plugin/logger";
import type { PluginClient } from "../plugin/types";

const log = createLogger("opencode-v2");

interface ToastInput {
  body?: { title?: string; message?: string; variant?: string };
}

/**
 * opencode v2 gives server plugins no SDK client. The shared v1 request pipeline only touches
 * a few client calls, all best-effort: toasts, clearing the stored credential after every
 * account is revoked, and session recovery (driven by v1 events, which v2 never delivers).
 * This stand-in turns them into log lines so the pipeline runs unchanged under v2.
 */
export function createV2ClientShim(): PluginClient {
  const unavailable = async (): Promise<never> => {
    throw new Error("Not available under opencode v2");
  };

  const shim = {
    tui: {
      showToast: async (input: ToastInput) => {
        log.info("toast", {
          title: input.body?.title,
          message: input.body?.message,
          variant: input.body?.variant,
        });
        return true;
      },
    },
    auth: {
      // v1 clears the stored credential when all accounts are revoked. Under v2 the next request
      // fails with a "run opencode auth login" error instead, so there is nothing to clear here.
      set: async () => {
        log.debug("auth.set ignored under opencode v2");
        return true;
      },
    },
    session: {
      prompt: unavailable,
      abort: unavailable,
      messages: unavailable,
    },
  };

  // Only the members above are reachable from the request pipeline; the full v1 SDK client
  // type cannot be satisfied without the v1 server behind it.
  return shim as unknown as PluginClient;
}
