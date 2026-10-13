import type { QuotaAccount, QuotaLimit, QuotaSnapshot, QuotaWindow } from "../../rpc";
import { createLogger } from "../plugin/logger";
import {
  checkAccountsQuota,
  type AccountQuotaResult,
  type QuotaGroupSummary,
  type QuotaSummaryGroup,
} from "../plugin/quota";
import { loadAccounts } from "../plugin/storage";
import type { PluginClient } from "../plugin/types";

const log = createLogger("opencode-v2.quota");

/** The shortest quota window is 5 hours; asking more than once a minute adds nothing. */
const QUOTA_CACHE_MS = 60_000;

type FetchQuota = typeof checkAccountsQuota;

function toPercent(fraction: number | undefined): number | null {
  return typeof fraction === "number" ? Math.round(fraction * 1000) / 10 : null;
}

function toTime(resetTime: string | undefined): number | null {
  const value = resetTime ? Date.parse(resetTime) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude & GPT". */
export function shortGroupName(displayName: string | undefined): string {
  const name = (displayName ?? "Models").replace(/\s+models$/i, "").replace(/\s+and\s+/i, " & ").trim();
  return name || "Models";
}

function summaryWindow(group: QuotaSummaryGroup, window: "5h" | "weekly"): QuotaWindow | null {
  const bucket = group.buckets?.find(
    (entry) => entry.window === window || entry.bucketId?.endsWith(window === "5h" ? "-5h" : "-weekly"),
  );
  if (!bucket) return null;
  return { remainingPercent: toPercent(bucket.remainingFraction), resetAt: toTime(bucket.resetTime) };
}

/** Limits from `retrieveUserQuotaSummary`: per model group, the 5-hour and the weekly window. */
function summaryLimits(groups: QuotaSummaryGroup[]): QuotaLimit[] {
  return groups.map((group) => ({
    name: shortGroupName(group.displayName),
    fiveHour: summaryWindow(group, "5h"),
    weekly: summaryWindow(group, "weekly"),
  }));
}

/**
 * Fallback without the summary: per-model 5-hour quota from `fetchAvailableModels`. Gemini Pro
 * and Flash draw on one bucket, so report the lower remaining and earlier reset.
 */
function mergeGroups(name: string, groups: Array<QuotaGroupSummary | undefined>): QuotaLimit | undefined {
  const present = groups.filter((group): group is QuotaGroupSummary => group !== undefined);
  if (present.length === 0) return undefined;
  const remaining = present
    .map((group) => group.remainingFraction)
    .filter((value): value is number => typeof value === "number");
  const resets = present.map((group) => toTime(group.resetTime)).filter((value): value is number => value !== null);
  return {
    name,
    fiveHour: {
      remainingPercent: remaining.length > 0 ? toPercent(Math.min(...remaining)) : null,
      resetAt: resets.length > 0 ? Math.min(...resets) : null,
    },
    weekly: null,
  };
}

export function toQuotaAccount(result: AccountQuotaResult, inUse: string[]): QuotaAccount {
  const groups = result.quota?.groups ?? {};
  const summaryGroups = result.quotaSummary?.groups ?? [];
  const limits =
    summaryGroups.length > 0
      ? summaryLimits(summaryGroups)
      : [
          mergeGroups("Gemini", [groups["gemini-pro"], groups["gemini-flash"]]),
          mergeGroups("Claude & GPT", [groups.claude]),
        ].filter((limit): limit is QuotaLimit => limit !== undefined);
  return {
    index: result.index,
    email: result.email ?? `Account ${result.index + 1}`,
    enabled: !result.disabled,
    inUse,
    limits,
    ...(result.error || result.quota?.error ? { error: result.error ?? result.quota?.error } : {}),
  };
}

/**
 * Builds the per-account quota snapshot the TUI sidebar shows. Results are cached for a minute
 * and concurrent callers share one fetch.
 */
export function createQuotaReporter(client: PluginClient, providerId: string, fetchQuota: FetchQuota = checkAccountsQuota) {
  let cached: QuotaSnapshot | undefined;
  let pending: Promise<QuotaSnapshot> | undefined;

  const build = async (): Promise<QuotaSnapshot> => {
    const storage = await loadAccounts();
    const accounts = storage?.accounts ?? [];
    const results = await fetchQuota(accounts, client, providerId);
    const activeGemini = storage?.activeIndexByFamily?.gemini ?? storage?.activeIndex ?? 0;
    const activeClaude = storage?.activeIndexByFamily?.claude ?? storage?.activeIndex ?? 0;

    const snapshot: QuotaSnapshot = {
      fetchedAt: Date.now(),
      accounts: results.map((result) => {
        const inUse = result.disabled
          ? []
          : [result.index === activeGemini ? "Gemini" : undefined, result.index === activeClaude ? "Claude" : undefined].filter(
              (name): name is string => name !== undefined,
            );
        return toQuotaAccount(result, inUse);
      }),
    };
    cached = snapshot;
    return snapshot;
  };

  return {
    snapshot(refresh = false): Promise<QuotaSnapshot> {
      if (!refresh && cached && Date.now() - cached.fetchedAt < QUOTA_CACHE_MS) {
        return Promise.resolve(cached);
      }
      pending ??= build()
        .catch((error: unknown) => {
          log.warn("quota check failed", { error: String(error) });
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    /** Drops the cached snapshot after the pool changed, so the next read reflects it. */
    invalidate(): void {
      cached = undefined;
    },
  };
}
