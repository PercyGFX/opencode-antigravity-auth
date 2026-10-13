// RPC shared by the OpenCode 2 server plugin (server.ts) and the TUI plugin (tui.tsx).
import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

/** Declared so the user sees why an account action failed (undeclared errors are masked). */
const ActionErrors = { failed: z.object({}) };

/** One Antigravity quota window (5 hours) for a group of models. */
export const QuotaLimitSchema = z.object({
  /** "Gemini" or "Claude & GPT-OSS" — the buckets Antigravity tracks separately. */
  name: z.string(),
  /** 0–100, or null when Antigravity did not report it. */
  remainingPercent: z.number().nullable(),
  /** When the window resets (epoch ms), or null when unknown. */
  resetAt: z.number().nullable(),
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
  },
  events: {},
});
