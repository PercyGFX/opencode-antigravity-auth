/**
 * Asks Antigravity which models it currently offers.
 *
 * `fetchAvailableModels` is called twice: with the current client's (hub) User-Agent, whose
 * Recommended list becomes the registry, and with the User-Agent normal requests use, so the
 * registry knows which model IDs only the hub client may call.
 */

import { ANTIGRAVITY_ENDPOINT_PROD, getHubUserAgent } from "../constants";
import { buildFingerprintHeaders, getSessionFingerprint } from "./fingerprint";
import { createLogger } from "./logger";
import { buildRegistryModels, type AvailableModelsResponse, type RegistryModel } from "./model-registry";

const log = createLogger("model-discovery");

const DISCOVERY_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  userAgent: string,
  fetchImpl: FetchLike,
): Promise<AvailableModelsResponse> {
  const response = await fetchImpl(`${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`fetchAvailableModels ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await response.json()) as AvailableModelsResponse;
}

/** What one account can use. */
export interface AccountModelDiscovery {
  /** Catalog entries from the account's Recommended list. */
  models: RegistryModel[];
  /** Every upstream model ID the account may call; models it lacks are missing (plan-dependent). */
  available: string[];
}

/**
 * Asks Antigravity which models this account can use. Throws when the list cannot be fetched or
 * has no recommended models, so callers keep what they had.
 */
export async function discoverAccountModels(
  accessToken: string,
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<AccountModelDiscovery> {
  const requestUserAgent = buildFingerprintHeaders(getSessionFingerprint())["User-Agent"];
  const [hub, regular] = await Promise.all([
    fetchAvailableModels(accessToken, projectId, getHubUserAgent(), fetchImpl),
    requestUserAgent
      ? fetchAvailableModels(accessToken, projectId, requestUserAgent, fetchImpl)
      : Promise.resolve<AvailableModelsResponse>({}),
  ]);

  const legacyIds = Object.keys(regular.models ?? {});
  const models = buildRegistryModels(hub, requestUserAgent ? new Set(legacyIds) : undefined);
  if (models.length === 0) {
    throw new Error("Antigravity returned no recommended models");
  }
  const available = [...new Set([...Object.keys(hub.models ?? {}), ...legacyIds])];
  log.info("discovered models", { count: models.length, ids: models.map((model) => model.id) });
  return { models, available };
}

/**
 * Returns the models Antigravity currently recommends for this account. Throws when the list
 * cannot be fetched or comes back empty, so callers keep their current list.
 */
export async function discoverRegistryModels(
  accessToken: string,
  projectId: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegistryModel[]> {
  return (await discoverAccountModels(accessToken, projectId, fetchImpl)).models;
}
