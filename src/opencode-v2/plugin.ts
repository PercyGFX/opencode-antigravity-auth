import { Credential, Integration, Plugin } from "@opencode/plugin";

import { AntigravityRpc } from "../../rpc";
import { authorizeAntigravity, exchangeAntigravity } from "../antigravity/oauth";
import {
  createAntigravityPlugin,
  getActiveAccountManager,
  getStateFromAuthorizationUrl,
  parseOAuthCallbackInput,
  persistAccountPool,
  shouldSkipLocalServer,
} from "../plugin";
import { isOAuthAuth, parseRefreshParts } from "../plugin/auth";
import { createLogger } from "../plugin/logger";
import { discoverRegistryModels } from "../plugin/model-discovery";
import { getRegistryFetchedAt, setRegistryModels } from "../plugin/model-registry";
import { startOAuthListener, type OAuthListener } from "../plugin/server";
import { loadAccounts } from "../plugin/storage";
import { refreshAccessToken } from "../plugin/token";
import type { AuthDetails, GetAuth, LoaderResult } from "../plugin/types";
import {
  ANTIGRAVITY_INTEGRATION_ID,
  ANTIGRAVITY_METHOD_ID,
  ANTIGRAVITY_PASTE_METHOD_ID,
  ANTIGRAVITY_PROVIDER_ID,
  antigravityModels,
  antigravityProviderInfo,
} from "./catalog";
import { poolAuth, removeAccount, setAccountEnabled } from "./accounts";
import { createV2ClientShim } from "./client-shim";
import { copyToClipboard } from "./clipboard";
import { ProxyRequestError, startLoopbackProxy } from "./proxy";
import { createQuotaReporter } from "./quota";

const log = createLogger("opencode-v2");

export const ANTIGRAVITY_V2_PLUGIN_ID = "opencode-antigravity-auth";

const LOGIN_HINT = `Run \`opencode auth login ${ANTIGRAVITY_INTEGRATION_ID}\` to sign in.`;

/** How long a discovered model list is used before asking Antigravity again. */
const MODEL_DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** OpenCode drops an unfinished sign-in after 10 minutes; give up on the browser well before. */
const BROWSER_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type PipelineFetch = LoaderResult["fetch"];

function linkSentence(copied: boolean): string {
  return copied
    ? "The sign-in link is copied to your clipboard (it is also shown below)."
    : "Copy the sign-in link shown below.";
}

/** Instructions for the browser flow: the local callback page finishes the sign-in. */
export function buildBrowserSignInInstructions(copied: boolean): string {
  return [
    linkSentence(copied),
    "Open it in any browser on this computer and sign in with Google.",
    'The browser then shows "All set!" and the sign-in finishes here on its own.',
  ].join(" ");
}

/** Instructions for the paste flow: no local server, the redirect URL is pasted back. */
export function buildPasteSignInInstructions(copied: boolean, reason?: string): string {
  return [
    reason,
    linkSentence(copied),
    "Open it in any browser and sign in with Google.",
    "Google then redirects to a localhost page that will not load; that is expected.",
    "Copy that page's full URL from the address bar and paste it here.",
  ]
    .filter(Boolean)
    .join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFetch(result: LoaderResult | Record<string, unknown>): result is LoaderResult {
  return typeof result.fetch === "function";
}

/**
 * opencode v2 entry point. It reuses the whole v1 pipeline (request rewriting, multi-account
 * rotation, quota fallback, recovery of thinking blocks) and only replaces the opencode-facing
 * glue that v2 changed:
 *
 * - sign-in: OAuth methods on the `google-antigravity` integration. The plugin never opens a
 *   browser; the link is copied and either the v1 callback page catches the redirect, or the
 *   redirect URL is pasted back;
 * - models: a `google-antigravity` provider listing what Antigravity currently recommends
 *   (discovered after sign-in and every few hours; a built-in list until then);
 * - requests: opencode's native Google client is pointed at a loopback proxy that feeds the
 *   v1 `fetch(url, init)` interceptor, because v2 no longer accepts a custom `fetch`.
 */
export function createAntigravityV2Plugin(): Plugin.Plugin {
  return Plugin.define({
    id: ANTIGRAVITY_V2_PLUGIN_ID,
    async setup(ctx) {
      const client = createV2ClientShim();
      const v1 = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)({
        client,
        directory: ctx.location.directory,
      });

      const getAuth: GetAuth = async (): Promise<AuthDetails> => {
        const connection = await ctx.integration.connection.active(ANTIGRAVITY_INTEGRATION_ID);
        const credential = connection
          ? await ctx.integration.connection.resolve(connection).catch((error: unknown) => {
              log.warn("could not resolve the Antigravity credential", { error: String(error) });
              return undefined;
            })
          : undefined;
        if (credential?.type !== "oauth") return { type: "none" };
        return {
          type: "oauth",
          refresh: credential.refresh,
          access: credential.access,
          expires: credential.expires,
        };
      };

      // The v1 loader loads the account pool and starts the refresh queue. It is built lazily on
      // the first request, and rebuilt when the signed-in account changes or a login adds one.
      let pipeline: { refresh: string; fetch: Promise<PipelineFetch> } | undefined;
      const getPipeline = async (): Promise<PipelineFetch> => {
        const auth = await getAuth();
        // Never call the v1 loader without an OAuth credential: it wipes the stored account pool
        // when it sees none, which would delete accounts that are only temporarily unreachable.
        if (!isOAuthAuth(auth)) {
          throw new ProxyRequestError(`Not signed in to Google Antigravity. ${LOGIN_HINT}`, 401);
        }
        if (pipeline?.refresh !== auth.refresh) {
          // Accounts removed from the pool must not come back through opencode's login.
          const loaderAuth = await poolAuth(auth);
          const getLoaderAuth: GetAuth = async () => {
            const latest = await getAuth();
            return isOAuthAuth(latest) ? loaderAuth : latest;
          };
          const current = {
            refresh: auth.refresh,
            fetch: v1.auth.loader(getLoaderAuth, { models: {} }).then((result) => {
              if (!hasFetch(result)) throw new ProxyRequestError(`Antigravity is not ready. ${LOGIN_HINT}`, 401);
              return result.fetch;
            }),
          };
          pipeline = current;
          current.fetch.catch(() => {
            if (pipeline === current) pipeline = undefined;
          });
        }
        return pipeline.fetch;
      };

      // Model discovery: ask Antigravity what it recommends and rebuild the catalog, so new
      // models appear (and retired ones disappear) without a plugin update.
      let discovering: Promise<void> | undefined;
      const refreshModels = (accessToken: string, projectId: string): Promise<void> => {
        discovering ??= (async () => {
          try {
            setRegistryModels(await discoverRegistryModels(accessToken, projectId));
            await ctx.provider.reload();
          } catch (error) {
            log.warn("model discovery failed; keeping the current model list", { error: String(error) });
          } finally {
            discovering = undefined;
          }
        })();
        return discovering;
      };
      const refreshModelsIfStale = async (): Promise<void> => {
        const fetchedAt = getRegistryFetchedAt();
        if (fetchedAt !== undefined && Date.now() - fetchedAt < MODEL_DISCOVERY_INTERVAL_MS) return;
        const auth = await getAuth();
        if (!isOAuthAuth(auth) || !auth.access) return;
        const parts = parseRefreshParts(auth.refresh);
        await refreshModels(auth.access, parts.managedProjectId || parts.projectId || "");
      };

      const proxy = await startLoopbackProxy(async (url, init) => {
        void refreshModelsIfStale().catch(() => {});
        const fetchThroughPipeline = await getPipeline();
        return fetchThroughPipeline(url, init);
      });

      // Google account emails by refresh token, so opencode can label each saved login.
      const emailsByRefreshToken = new Map<string, string>();
      const rememberEmail = (refresh: string, email: string | undefined) => {
        const token = parseRefreshParts(refresh).refreshToken;
        if (token && email) emailsByRefreshToken.set(token, email);
      };
      void loadAccounts()
        .then((storage) => {
          for (const account of storage?.accounts ?? []) rememberEmail(account.refreshToken, account.email);
        })
        .catch(() => {});
      const label = (credential: Credential.OAuth) =>
        emailsByRefreshToken.get(parseRefreshParts(credential.refresh).refreshToken);

      /** Exchanges the authorization code, adds the account to the pool, returns the credential. */
      const finishSignIn = async (code: string, state: string, methodID: string) => {
        const result = await exchangeAntigravity(code, state);
        if (result.type === "failed") throw new Error(`Google sign-in failed: ${result.error}`);

        // Same pool file as v1, so earlier accounts and rotation state carry over.
        await persistAccountPool([result], false);
        rememberEmail(result.refresh, result.email);
        pipeline = undefined;
        log.info("account added", { email: result.email });
        void refreshModels(result.access, result.projectId);

        return Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make(methodID),
          refresh: result.refresh,
          access: result.access,
          expires: Math.max(0, Math.floor(result.expires)),
        });
      };

      const pasteAuthorization = async (methodID: string, reason?: string) => {
        const authorization = await authorizeAntigravity("");
        const fallbackState = getStateFromAuthorizationUrl(authorization.url);
        const copied = await copyToClipboard(authorization.url);
        return {
          mode: "code" as const,
          url: authorization.url,
          instructions: buildPasteSignInInstructions(copied, reason),
          callback: async (pasted: string) => {
            const params = parseOAuthCallbackInput(pasted, fallbackState);
            if ("error" in params) throw new Error(params.error);
            return finishSignIn(params.code, params.state, methodID);
          },
        };
      };

      // Port 51121 is fixed by the OAuth client's redirect URI, so only one browser sign-in can
      // wait at a time; a new attempt replaces an abandoned one.
      let listener: OAuthListener | undefined;
      const closeListener = async () => {
        const current = listener;
        listener = undefined;
        await current?.close().catch(() => {});
      };

      const browserAuthorization = async () => {
        if (shouldSkipLocalServer()) {
          return pasteAuthorization(
            ANTIGRAVITY_METHOD_ID,
            "This looks like a remote or WSL session, so the redirect cannot reach a local page.",
          );
        }

        await closeListener();
        let current: OAuthListener;
        try {
          current = await startOAuthListener({ timeoutMs: BROWSER_CALLBACK_TIMEOUT_MS });
        } catch (error) {
          log.warn("could not start the OAuth callback listener", { error: String(error) });
          return pasteAuthorization(
            ANTIGRAVITY_METHOD_ID,
            "Port 51121 is busy, so the browser cannot report back on its own.",
          );
        }
        listener = current;

        let authorization: Awaited<ReturnType<typeof authorizeAntigravity>>;
        try {
          authorization = await authorizeAntigravity("");
        } catch (error) {
          await closeListener();
          throw error;
        }
        const copied = await copyToClipboard(authorization.url);

        const callback = (async () => {
          try {
            const url = await current.waitForCallback();
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");
            if (!code || !state) {
              throw new Error(url.searchParams.get("error") ?? "Missing code or state in the Google redirect");
            }
            return await finishSignIn(code, state, ANTIGRAVITY_METHOD_ID);
          } finally {
            if (listener === current) listener = undefined;
            await current.close().catch(() => {});
          }
        })();
        // opencode stops awaiting an abandoned attempt; keep its later rejection from going unhandled.
        callback.catch(() => {});

        return {
          mode: "auto" as const,
          url: authorization.url,
          instructions: buildBrowserSignInInstructions(copied),
          callback,
        };
      };

      const refresh = async (credential: Credential.OAuth) => {
        const refreshed = await refreshAccessToken(
          {
            type: "oauth",
            refresh: credential.refresh,
            access: credential.access,
            expires: credential.expires,
          },
          client,
          ANTIGRAVITY_PROVIDER_ID,
        );
        if (!refreshed?.access) {
          throw new Error(`Google Antigravity token refresh failed. ${LOGIN_HINT}`);
        }
        return Credential.OAuth.make({
          ...credential,
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: Math.max(0, Math.floor(refreshed.expires ?? Date.now() + 3_600_000)),
        });
      };

      await ctx.integration.transform((editor) => {
        editor.update(ANTIGRAVITY_INTEGRATION_ID, (integration) => {
          integration.name = "Google Antigravity";
        });
        editor.method.update({
          integrationID: ANTIGRAVITY_INTEGRATION_ID,
          method: { id: ANTIGRAVITY_METHOD_ID, type: "oauth", label: "Google account (Antigravity)" },
          authorize: browserAuthorization,
          refresh,
          label,
        });
        editor.method.update({
          integrationID: ANTIGRAVITY_INTEGRATION_ID,
          method: {
            id: ANTIGRAVITY_PASTE_METHOD_ID,
            type: "oauth",
            label: "Google account (Antigravity, paste the redirect URL)",
          },
          authorize: () => pasteAuthorization(ANTIGRAVITY_PASTE_METHOD_ID),
          refresh,
          label,
        });
      });

      await ctx.provider.transform((editor) => {
        editor.add({ info: antigravityProviderInfo(proxy.baseURL), models: antigravityModels() });
      });

      // Per-account quota and account actions for the TUI sidebar (tui.tsx).
      const quota = createQuotaReporter(client, ANTIGRAVITY_PROVIDER_ID);
      await ctx.rpc.register(AntigravityRpc, {
        quota: async (input) => quota.snapshot(input.refresh === true),
        setAccountEnabled: async (input, call) => {
          try {
            await setAccountEnabled(getActiveAccountManager(), input.index, input.email, input.enabled);
          } catch (error) {
            return call.error("failed", errorMessage(error), {});
          }
          quota.invalidate();
          return {};
        },
        removeAccount: async (input, call) => {
          let remaining: number;
          try {
            remaining = await removeAccount(getActiveAccountManager(), input.index, input.email);
          } catch (error) {
            return call.error("failed", errorMessage(error), {});
          }
          quota.invalidate();
          return { remaining };
        },
      });
      void refreshModelsIfStale().catch(() => {});

      return async () => {
        await closeListener();
        await proxy.close();
      };
    },
  });
}
