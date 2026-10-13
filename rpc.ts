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
  },
  events: {},
});
