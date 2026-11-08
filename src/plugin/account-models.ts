/**
 * Per-account model discovery.
 *
 * Antigravity offers different models on different plans: free accounts get Claude 4.6, paid
 * Pro accounts get Claude 5.5 and Gemini 4 Argon. Each account's list is asked for separately
 * and stored with the account, so request routing only picks accounts that have the requested
 * model, and the catalog offers every model at least one account has.
 */

import type { AccountManager } from "./accounts";
import { accessTokenExpired, formatRefreshParts } from "./auth";
import { createLogger } from "./logger";
import { discoverAccountModels, type AccountModelDiscovery } from "./model-discovery";
import { getRegistryModels, mergeRegistryModels, setRegistryModels, type RegistryModel } from "./model-registry";
import { updateAccountModels, type AccountModelsUpdate } from "./storage";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const log = createLogger("account-models");

/** An account to discover; `access`/`expires` skip the token refresh when still valid. */
export interface PoolModelsAccount {
  refreshToken: string;
  email?: string;
  projectId?: string;
  managedProjectId?: string;
  access?: string;
  expires?: number;
  /** The list stored by the previous discovery, kept in the catalog if this one fails. */
  availableModels?: string[];
}

export interface PoolModelsResult {
  account: PoolModelsAccount;
  discovery?: AccountModelDiscovery;
  error?: string;
}

type Discover = (accessToken: string, projectId: string) => Promise<AccountModelDiscovery>;

async function accessTokenFor(account: PoolModelsAccount, client: PluginClient, providerId: string): Promise<string> {
  const auth: OAuthAuthDetails = {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: account.access,
    expires: account.expires,
  };
  if (auth.access && !accessTokenExpired(auth)) return auth.access;
  const refreshed = await refreshAccessToken(auth, client, providerId);
  if (!refreshed?.access) throw new Error("Antigravity token refresh failed");
  return refreshed.access;
}

/** Discovers every account's models in parallel. A failure only affects that account's result. */
export async function discoverPoolModels(
  accounts: readonly PoolModelsAccount[],
  client: PluginClient,
  providerId: string,
  discover: Discover = discoverAccountModels,
): Promise<PoolModelsResult[]> {
  return Promise.all(
    accounts.map(async (account): Promise<PoolModelsResult> => {
      try {
        const accessToken = await accessTokenFor(account, client, providerId);
        const discovery = await discover(accessToken, account.managedProjectId || account.projectId || "");
        return { account, discovery };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("model discovery failed for an account", { email: account.email, error: message });
        return { account, error: message };
      }
    }),
  );
}

function hasAnyModel(model: RegistryModel, available: readonly string[]): boolean {
  return [model.upstreamId, ...model.variants.map((variant) => variant.upstreamId)].some((id) =>
    available.includes(id),
  );
}

/**
 * Makes the combined list the catalog and stores each discovered account's list, on disk and in
 * the running account manager. Accounts whose discovery failed keep their previous list, and
 * their models stay in the catalog. Returns false when no account answered.
 */
export async function applyPoolModels(
  results: readonly PoolModelsResult[],
  manager: AccountManager | null,
  now: number = Date.now(),
): Promise<boolean> {
  const discovered = results.flatMap((result) => (result.discovery ? [{ ...result, discovery: result.discovery }] : []));
  if (discovered.length === 0) return false;

  const previous = getRegistryModels();
  const kept = results.flatMap((result) => {
    const stored = result.account.availableModels;
    return !result.discovery && stored ? [previous.filter((model) => hasAnyModel(model, stored))] : [];
  });
  setRegistryModels(mergeRegistryModels([...discovered.map((result) => result.discovery.models), ...kept]), now);

  const updates: AccountModelsUpdate[] = discovered.map((result) => ({
    refreshToken: result.account.refreshToken,
    availableModels: result.discovery.available,
    availableModelsUpdatedAt: now,
  }));
  for (const update of updates) {
    manager?.setAvailableModels(update.refreshToken, update.availableModels, now);
  }
  await updateAccountModels(updates);
  return true;
}
