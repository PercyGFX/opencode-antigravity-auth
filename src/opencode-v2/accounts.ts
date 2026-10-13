import { formatRefreshParts, parseRefreshParts } from "../plugin/auth";
import type { AccountManager } from "../plugin/accounts";
import {
  hashRefreshToken,
  loadAccounts,
  retireRefreshTokens,
  saveAccountsReplace,
  type AccountMetadataV3,
  type AccountStorageV4,
} from "../plugin/storage";
import type { OAuthAuthDetails } from "../plugin/types";

export class AccountNotFoundError extends Error {
  constructor(email: string) {
    super(`Account ${email} is no longer in the pool. Refresh and try again.`);
    this.name = "AccountNotFoundError";
  }
}

/** Fallback name for accounts without an email, matching the quota snapshot. */
export function accountLabel(account: { email?: string }, index: number): string {
  return account.email ?? `Account ${index + 1}`;
}

/** Finds an account by its position and label; falls back to the label if the list shifted. */
function findAccount(accounts: ReadonlyArray<{ email?: string }>, index: number, email: string): number {
  const atIndex = accounts[index];
  if (atIndex && accountLabel(atIndex, index) === email) return index;
  return accounts.findIndex((account, position) => accountLabel(account, position) === email);
}

async function loadPool(): Promise<AccountStorageV4> {
  const storage = await loadAccounts();
  if (!storage) throw new Error("No Antigravity accounts are signed in.");
  return storage;
}

/**
 * Enables or disables an account for rotation. Goes through the running pipeline's account
 * manager when there is one (it owns the pool in memory and would overwrite file edits).
 */
export async function setAccountEnabled(
  manager: AccountManager | null,
  index: number,
  email: string,
  enabled: boolean,
): Promise<void> {
  if (manager) {
    const position = findAccount(manager.getAccounts(), index, email);
    if (position < 0 || !manager.setAccountEnabled(position, enabled)) throw new AccountNotFoundError(email);
    await manager.saveToDisk();
    return;
  }
  const storage = await loadPool();
  const position = findAccount(storage.accounts, index, email);
  const account = storage.accounts[position];
  if (!account) throw new AccountNotFoundError(email);
  account.enabled = enabled;
  await saveAccountsReplace(storage);
}

function shiftIndex(value: number | undefined, removed: number, length: number): number | undefined {
  if (value === undefined) return undefined;
  const shifted = value > removed ? value - 1 : value;
  return length === 0 ? 0 : Math.min(Math.max(shifted, 0), length - 1);
}

/** Removes an account from the pool. Returns how many accounts remain. */
export async function removeAccount(manager: AccountManager | null, index: number, email: string): Promise<number> {
  if (manager) {
    const accounts = manager.getAccounts();
    const account = accounts[findAccount(accounts, index, email)];
    if (!account || !manager.removeAccount(account)) throw new AccountNotFoundError(email);
    // A merging save would bring the removed account back from the file, and other account
    // managers still holding it would merge it back later: replace the file and retire the token.
    await manager.saveToDisk({ replace: true });
    await retireRefreshTokens([account.parts.refreshToken]);
    return manager.getAccountCount();
  }
  const storage = await loadPool();
  const position = findAccount(storage.accounts, index, email);
  if (position < 0) throw new AccountNotFoundError(email);
  const [removed] = storage.accounts.splice(position, 1);
  if (removed) {
    storage.retiredTokenHashes = [...(storage.retiredTokenHashes ?? []), hashRefreshToken(removed.refreshToken)];
  }
  const length = storage.accounts.length;
  storage.activeIndex = shiftIndex(storage.activeIndex, position, length) ?? 0;
  if (storage.activeIndexByFamily) {
    storage.activeIndexByFamily = {
      claude: shiftIndex(storage.activeIndexByFamily.claude, position, length),
      gemini: shiftIndex(storage.activeIndexByFamily.gemini, position, length),
    };
  }
  await saveAccountsReplace(storage);
  return length;
}

function toAuth(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
  };
}

/**
 * The credential handed to the v1 account manager. The manager always adds the account behind
 * that credential to the pool, so passing opencode's login after the user removed its account
 * would bring the account back. Use the login only while its account is still in the pool;
 * otherwise use an enabled pool account.
 */
export async function poolAuth(auth: OAuthAuthDetails): Promise<OAuthAuthDetails> {
  const storage = await loadAccounts().catch(() => null);
  const accounts = storage?.accounts ?? [];
  const token = parseRefreshParts(auth.refresh).refreshToken;
  if (accounts.length === 0 || accounts.some((account) => account.refreshToken === token)) return auth;
  const fallback = accounts.find((account) => account.enabled !== false) ?? accounts[0];
  return fallback ? toAuth(fallback) : auth;
}
