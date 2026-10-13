import type { QuotaAccount, QuotaLimit } from "../../rpc";

export type QuotaLevel = "ok" | "low" | "critical" | "unknown";

/** "4h 48m", "12m", "now"; empty when Antigravity gave no reset time. */
export function formatReset(resetAt: number | null, now: number): string {
  if (resetAt === null) return "";
  const minutes = Math.ceil((resetAt - now) / 60_000);
  if (minutes <= 0) return "now";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

export function formatPercent(limit: QuotaLimit): string {
  if (limit.remainingPercent === null) return "?";
  return `${Math.floor(limit.remainingPercent)}%`;
}

export function limitLevel(limit: QuotaLimit): QuotaLevel {
  if (limit.remainingPercent === null) return "unknown";
  if (limit.remainingPercent <= 10) return "critical";
  if (limit.remainingPercent <= 30) return "low";
  return "ok";
}

/** The worst level among an account's limits, for its status dot. */
export function accountLevel(account: QuotaAccount): QuotaLevel {
  if (account.error || !account.enabled) return "unknown";
  const levels = account.limits.map(limitLevel);
  if (levels.includes("critical")) return "critical";
  if (levels.includes("low")) return "low";
  if (levels.includes("ok")) return "ok";
  return "unknown";
}

/**
 * The account serving the selected model's group first, then other accounts in use, then the
 * remaining enabled ones, then disabled ones; stable otherwise.
 */
export function sortAccounts(accounts: readonly QuotaAccount[], currentGroup?: string): QuotaAccount[] {
  const rank = (account: QuotaAccount) => {
    if (!account.enabled) return 3;
    if (currentGroup !== undefined && account.inUse.includes(currentGroup)) return 0;
    return account.inUse.length > 0 ? 1 : 2;
  };
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
    .map(({ account }) => account);
}
