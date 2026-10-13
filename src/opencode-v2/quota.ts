import type { QuotaAccount, QuotaLimit, QuotaSnapshot } from "../../rpc";
import { createLogger } from "../plugin/logger";
import { checkAccountsQuota, type AccountQuotaResult, type QuotaGroupSummary } from "../plugin/quota";
import { loadAccounts } from "../plugin/storage";
import type { PluginClient } from "../plugin/types";

const log = createLogger("opencode-v2.quota");

/** Antigravity quota windows are 5 hours long; asking more than once a minute adds nothing. */
const QUOTA_CACHE_MS = 60_000;

type FetchQuota = typeof checkAccountsQuota;

function toPercent(fraction: number | undefined): number | null {
  return typeof fraction === "number" ? Math.round(fraction * 1000) / 10 : null;
}

function toTime(resetTime: string | undefined): number | null {
  const value = resetTime ? Date.parse(resetTime) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/** Gemini Pro and Flash draw on one bucket: report the lower remaining and earlier reset. */
function mergeGroups(name: string, groups: Array<QuotaGroupSummary | undefined>): QuotaLimit | undefined {
  const present = groups.filter((group): group is QuotaGroupSummary => group !== undefined);
  if (present.length === 0) return undefined;
  const remaining = present
    .map((group) => group.remainingFraction)
    .filter((value): value is number => typeof value === "number");
  const resets = present.map((group) => toTime(group.resetTime)).filter((value): value is number => value !== null);
  return {
    name,
    remainingPercent: remaining.length > 0 ? toPercent(Math.min(...remaining)) : null,
    resetAt: resets.length > 0 ? Math.min(...resets) : null,
  };
}

export function toQuotaAccount(result: AccountQuotaResult, inUse: string[]): QuotaAccount {
  const groups = result.quota?.groups ?? {};
  const limits = [
    mergeGroups("Gemini", [groups["gemini-pro"], groups["gemini-flash"]]),
    mergeGroups("Claude & GPT-OSS", [groups.claude]),
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
