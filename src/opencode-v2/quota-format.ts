import type { QuotaAccount, QuotaLimit, QuotaWindow } from "../../rpc";

export type QuotaLevel = "ok" | "low" | "critical" | "unknown";

/** "6d 23h", "4h 48m", "12m", "now"; empty when Antigravity gave no reset time. */
export function formatReset(resetAt: number | null, now: number): string {
  if (resetAt === null) return "";
  const minutes = Math.ceil((resetAt - now) / 60_000);
  if (minutes <= 0) return "now";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

/** The windows to show for a group: "5h" first, then "wk" (weekly); missing ones are skipped. */
export function windowsOf(limit: QuotaLimit): Array<{ label: "5h" | "wk"; window: QuotaWindow }> {
  const entries: Array<{ label: "5h" | "wk"; window: QuotaWindow }> = [];
  if (limit.fiveHour) entries.push({ label: "5h", window: limit.fiveHour });
  if (limit.weekly) entries.push({ label: "wk", window: limit.weekly });
  return entries;
}

export function formatPercent(window: QuotaWindow): string {
  if (window.remainingPercent === null) return "?";
  return `${Math.floor(window.remainingPercent)}%`;
}

export function windowLevel(window: QuotaWindow): QuotaLevel {
  if (window.remainingPercent === null) return "unknown";
  if (window.remainingPercent <= 10) return "critical";
  if (window.remainingPercent <= 30) return "low";
  return "ok";
}

/** The worst level among all of an account's windows, for its status dot. */
export function accountLevel(account: QuotaAccount): QuotaLevel {
  if (account.error || !account.enabled) return "unknown";
  const levels = account.limits
    .flatMap((limit) => [limit.fiveHour, limit.weekly])
    .filter((window): window is QuotaWindow => window !== null)
    .map(windowLevel);
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
