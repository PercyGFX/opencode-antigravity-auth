// RPC shared by the OpenCode 2 server plugin (server.ts) and the TUI plugin (tui.tsx).
import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

/** Declared so the user sees why an account action failed (undeclared errors are masked). */
const ActionErrors = { failed: z.object({}) };

/** One quota window (5-hour or weekly) of a model group. */
export const QuotaWindowSchema = z.object({
  /** 0–100, or null when Antigravity did not report it. */
  remainingPercent: z.number().nullable(),
  /** When the window fully refreshes (epoch ms), or null when unknown. */
  resetAt: z.number().nullable(),
});

/** A group of models sharing limits, e.g. "Gemini" or "Claude & GPT". */
export const QuotaLimitSchema = z.object({
  name: z.string(),
  /** The 5-hour limit, which smooths demand across all users. */
  fiveHour: QuotaWindowSchema.nullable(),
  /** The weekly limit, tied to the account's plan; null when Antigravity did not report it. */
  weekly: QuotaWindowSchema.nullable(),
});

export const QuotaAccountSchema = z.object({
  /** Position in the account pool; account actions pass it back with the email. */
  index: z.number(),
  email: z.string(),
  enabled: z.boolean(),
  /** Model groups this account is currently serving, e.g. ["Gemini"]. */
  inUse: z.array(z.string()),
  limits: z.array(QuotaLimitSchema),
  error: z.string().optional(),
});

export const QuotaSnapshotSchema = z.object({
  fetchedAt: z.number(),
  accounts: z.array(QuotaAccountSchema),
});

export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type QuotaLimit = z.infer<typeof QuotaLimitSchema>;
export type QuotaAccount = z.infer<typeof QuotaAccountSchema>;
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const AntigravityRpc = Rpc.define({
  id: "antigravity",
  methods: {
    /** Per-account quota for the signed-in Antigravity accounts. */
    quota: {
      input: z.object({ refresh: z.boolean().optional() }),
      output: QuotaSnapshotSchema,
    },
    /** Takes an account out of rotation, or puts it back. */
    setAccountEnabled: {
      input: z.object({ index: z.number(), email: z.string(), enabled: z.boolean() }),
      output: z.object({}),
      errors: ActionErrors,
    },
    /** Removes an account from the pool; reports how many remain. */
    removeAccount: {
      input: z.object({ index: z.number(), email: z.string() }),
      output: z.object({ remaining: z.number() }),
      errors: ActionErrors,
    },
    /**
     * Starts a sign-in the plugin runs itself (re-authenticate / add account): it updates the
     * account pool without adding another opencode login. `email` preselects that account.
     */
    signInStart: {
      input: z.object({ email: z.string().optional() }),
      output: z.object({
        attemptID: z.string(),
        mode: z.enum(["auto", "code"]),
        url: z.string(),
        instructions: z.string(),
      }),
      errors: ActionErrors,
    },
    /** Progress of a browser sign-in ("auto" mode). */
    signInStatus: {
      input: z.object({ attemptID: z.string() }),
      output: z.object({
        status: z.enum(["pending", "complete", "failed", "expired"]),
        message: z.string().optional(),
        email: z.string().optional(),
      }),
    },
    /** Finishes a paste sign-in ("code" mode) with the redirect URL or code. */
    signInComplete: {
      input: z.object({ attemptID: z.string(), code: z.string() }),
      output: z.object({ email: z.string().optional() }),
      errors: ActionErrors,
    },
    signInCancel: {
      input: z.object({ attemptID: z.string() }),
      output: z.object({}),
    },
  },
  events: {},
});
