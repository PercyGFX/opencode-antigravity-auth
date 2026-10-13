import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Plugin } from "@opencode/plugin";

const mocks = vi.hoisted(() => ({
  loader: vi.fn(),
  persistAccountPool: vi.fn(async () => {}),
  authorizeAntigravity: vi.fn(async () => ({
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=STATE123",
    verifier: "verifier",
    projectId: "",
  })),
  exchangeAntigravity: vi.fn(),
  copyToClipboard: vi.fn(async () => true),
  refreshAccessToken: vi.fn(),
  startOAuthListener: vi.fn(),
  shouldSkipLocalServer: vi.fn(() => false),
  discoverRegistryModels: vi.fn(),
  quotaReporter: vi.fn(async (_refresh?: boolean) => ({ fetchedAt: 1, accounts: [] })),
  quotaInvalidate: vi.fn(),
}));

// @opencode-ai/plugin 0.15 ships extensionless ESM imports that only Bun resolves.
vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));
vi.mock("../plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin")>()),
  createAntigravityPlugin: () => async () => ({
    auth: { provider: "google-antigravity", loader: mocks.loader, methods: [] },
  }),
  persistAccountPool: mocks.persistAccountPool,
  shouldSkipLocalServer: mocks.shouldSkipLocalServer,
}));
vi.mock("../plugin/server", () => ({ startOAuthListener: mocks.startOAuthListener }));
vi.mock("../antigravity/oauth", () => ({
  authorizeAntigravity: mocks.authorizeAntigravity,
  exchangeAntigravity: mocks.exchangeAntigravity,
}));
vi.mock("./clipboard", () => ({ copyToClipboard: mocks.copyToClipboard }));
vi.mock("../plugin/token", () => ({ refreshAccessToken: mocks.refreshAccessToken }));
vi.mock("../plugin/model-discovery", () => ({ discoverRegistryModels: mocks.discoverRegistryModels }));
vi.mock("./quota", () => ({
  createQuotaReporter: () => ({ snapshot: mocks.quotaReporter, invalidate: mocks.quotaInvalidate }),
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { builtinRegistryModels, resetRegistryForTests, setRegistryModels } from "../plugin/model-registry";
import {
  ANTIGRAVITY_INTEGRATION_ID,
  ANTIGRAVITY_METHOD_ID,
  ANTIGRAVITY_PASTE_METHOD_ID,
  ANTIGRAVITY_PROVIDER_ID,
} from "./catalog";
import { createAntigravityV2Plugin } from "./plugin";

interface StoredCredential {
  type: "oauth";
  methodID: string;
  refresh: string;
  access: string;
  expires: number;
}

interface CodeAuthorization {
  mode: "code";
  url: string;
  instructions: string;
  callback: (code: string) => Promise<StoredCredential>;
}

interface AutoAuthorization {
  mode: "auto";
  url: string;
  instructions: string;
  callback: Promise<StoredCredential>;
}

interface OAuthRegistration<A = CodeAuthorization> {
  integrationID: string;
  method: { id: string; type: string; label: string };
  authorize: (answer: Record<string, unknown>) => Promise<A>;
  refresh: (credential: StoredCredential) => Promise<StoredCredential>;
  label?: (credential: StoredCredential) => string | undefined;
}

interface ProviderAdd {
  info: { id: string; settings?: { baseURL?: string } };
  models: Array<{ id: string }>;
}

const SIGNED_IN: StoredCredential = {
  type: "oauth",
  methodID: ANTIGRAVITY_METHOD_ID,
  refresh: "refresh-token|project-1",
  access: "access-token",
  expires: Date.now() + 3_600_000,
};

const setup = async (credential?: StoredCredential) => {
  const integrationEditor = { update: vi.fn(), method: { update: vi.fn() } };
  const providerEditor = { add: vi.fn() };
  const ctx = {
    location: { directory: "/tmp/project" },
    integration: {
      transform: vi.fn(async (edit: (editor: typeof integrationEditor) => void) => edit(integrationEditor)),
      connection: {
        active: vi.fn(async () => (credential ? { id: "connection-1" } : undefined)),
        resolve: vi.fn(async () => credential),
      },
    },
    provider: {
      transform: vi.fn(async (edit: (editor: typeof providerEditor) => void) => edit(providerEditor)),
      reload: vi.fn(async () => {}),
    },
    rpc: {
      register: vi.fn(async (_definition: { id: string }, _handlers: Record<string, (input: unknown) => Promise<unknown>>) => ({
        dispose: async () => {},
        events: { emit: async () => {} },
      })),
    },
  };

  const plugin = createAntigravityV2Plugin();
  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context);

  const browser = integrationEditor.method.update.mock.calls[0]?.[0] as OAuthRegistration<
    AutoAuthorization | CodeAuthorization
  >;
  // Most sign-in tests use the paste method, which is always "code" mode.
  const registration = integrationEditor.method.update.mock.calls[1]?.[0] as OAuthRegistration;
  const added = providerEditor.add.mock.calls[0]?.[0] as ProviderAdd;
  return {
    cleanup,
    browser,
    registration,
    added,
    integrationEditor,
    providerReload: ctx.provider.reload,
    rpcRegister: ctx.rpc.register,
  };
};

let cleanups: Array<() => unknown> = [];

let registryDir: string;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

beforeEach(() => {
  vi.clearAllMocks();
  // Discovery writes the model cache; keep it out of the real config directory.
  registryDir = mkdtempSync(join(tmpdir(), "antigravity-v2-"));
  process.env.OPENCODE_CONFIG_DIR = registryDir;
  resetRegistryForTests(builtinRegistryModels());
  mocks.discoverRegistryModels.mockResolvedValue(builtinRegistryModels());
});

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
  resetRegistryForTests();
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  rmSync(registryDir, { recursive: true, force: true });
});

/** Lets fire-and-forget work (discovery, catalog reload) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const track = async (credential?: StoredCredential) => {
  const result = await setup(credential);
  if (typeof result.cleanup === "function") cleanups.push(result.cleanup);
  return result;
};

const generate = (baseURL: string) =>
  fetch(`${baseURL}/models/antigravity-gemini-3-flash:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "access-token" },
    body: '{"contents":[]}',
  });

describe("createAntigravityV2Plugin", () => {
  it("registers browser and paste OAuth methods on its own integration", async () => {
    const { browser, registration, integrationEditor } = await track();

    expect(integrationEditor.update).toHaveBeenCalledWith(ANTIGRAVITY_INTEGRATION_ID, expect.any(Function));
    expect(browser.integrationID).toBe(ANTIGRAVITY_INTEGRATION_ID);
    expect(browser.method).toMatchObject({ id: ANTIGRAVITY_METHOD_ID, type: "oauth" });
    expect(registration.integrationID).toBe(ANTIGRAVITY_INTEGRATION_ID);
    expect(registration.method).toMatchObject({ id: ANTIGRAVITY_PASTE_METHOD_ID, type: "oauth" });

    const authorization = await registration.authorize({});
    expect(authorization.mode).toBe("code");
    expect(authorization.url).toContain("accounts.google.com");
    expect(authorization.instructions).toContain("copied to your clipboard");
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(authorization.url);
  });

  it("falls back to plain instructions when the clipboard is unavailable", async () => {
    mocks.copyToClipboard.mockResolvedValueOnce(false);
    const { registration } = await track();
    const authorization = await registration.authorize({});
    expect(authorization.instructions).not.toContain("clipboard");
    expect(authorization.instructions).toContain("Copy the sign-in link");
  });

  it("exchanges a pasted redirect URL, saves the account and returns the credential", async () => {
    mocks.exchangeAntigravity.mockResolvedValueOnce({
      type: "success",
      refresh: "new-refresh|project-9",
      access: "new-access",
      expires: 1_900_000_000_000.7,
      email: "user@example.com",
      projectId: "project-9",
    });
    const { registration } = await track();
    const authorization = await registration.authorize({});

    const credential = await authorization.callback(
      "http://localhost:51121/oauth-callback?code=auth-code&state=STATE123&scope=x",
    );

    expect(mocks.exchangeAntigravity).toHaveBeenCalledWith("auth-code", "STATE123");
    expect(mocks.persistAccountPool).toHaveBeenCalledWith([expect.objectContaining({ email: "user@example.com" })], false);
    expect(credential).toEqual({
      type: "oauth",
      methodID: ANTIGRAVITY_PASTE_METHOD_ID,
      refresh: "new-refresh|project-9",
      access: "new-access",
      expires: 1_900_000_000_000,
    });
    // opencode labels the saved login with the Google account's email.
    expect(registration.label?.(credential)).toBe("user@example.com");
  });

  it("accepts a bare authorization code using the state from the sign-in link", async () => {
    mocks.exchangeAntigravity.mockResolvedValueOnce({
      type: "success",
      refresh: "r|p",
      access: "a",
      expires: 1,
      projectId: "p",
    });
    const { registration } = await track();
    const authorization = await registration.authorize({});
    await authorization.callback("  bare-code  ");
    expect(mocks.exchangeAntigravity).toHaveBeenCalledWith("bare-code", "STATE123");
  });

  it("fails the login when the token exchange fails, without saving anything", async () => {
    mocks.exchangeAntigravity.mockResolvedValueOnce({ type: "failed", error: "invalid_grant" });
    const { registration } = await track();
    const authorization = await registration.authorize({});
    await expect(authorization.callback("http://localhost:51121/oauth-callback?code=c&state=s")).rejects.toThrow(
      "Google sign-in failed: invalid_grant",
    );
    expect(mocks.persistAccountPool).not.toHaveBeenCalled();
  });

  it("adds the google-antigravity provider pointed at the loopback proxy", async () => {
    const { added } = await track();
    expect(added.info.id).toBe(ANTIGRAVITY_PROVIDER_ID);
    expect(added.info.settings?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/v1beta$/);
    expect(added.models.map((model) => model.id)).toEqual(Object.keys(OPENCODE_MODEL_DEFINITIONS));
  });

  it("answers 401 without ever running the v1 loader when nobody is signed in", async () => {
    const { added } = await track();
    const response = await generate(added.info.settings!.baseURL!);
    expect(response.status).toBe(401);
    expect((await response.json()).error.message).toContain("opencode auth login google-antigravity");
    // The v1 loader clears the account pool when it sees no OAuth credential.
    expect(mocks.loader).not.toHaveBeenCalled();
  });

  it("feeds proxied requests to the v1 pipeline and builds it only once", async () => {
    const pipelineFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('data: {"ok":true}\n\n', { status: 200 }),
    );
    mocks.loader.mockResolvedValue({ apiKey: "", fetch: pipelineFetch });
    const { added } = await track(SIGNED_IN);
    const baseURL = added.info.settings!.baseURL!;

    const first = await generate(baseURL);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('data: {"ok":true}\n\n');
    await (await generate(baseURL)).text();

    expect(mocks.loader).toHaveBeenCalledTimes(1);
    const getAuth = mocks.loader.mock.calls[0]![0] as () => Promise<unknown>;
    expect(await getAuth()).toEqual({
      type: "oauth",
      refresh: SIGNED_IN.refresh,
      access: SIGNED_IN.access,
      expires: SIGNED_IN.expires,
    });
    expect(pipelineFetch).toHaveBeenCalledTimes(2);
    expect(pipelineFetch.mock.calls[0]![0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent?alt=sse",
    );
  });

  it("refreshes the stored credential through the v1 token refresh", async () => {
    mocks.refreshAccessToken.mockResolvedValueOnce({
      type: "oauth",
      refresh: "refresh-token|project-1",
      access: "fresh-access",
      expires: 2_000_000_000_000,
    });
    const { registration } = await track();
    const refreshed = await registration.refresh(SIGNED_IN);
    expect(refreshed).toEqual({ ...SIGNED_IN, access: "fresh-access", expires: 2_000_000_000_000 });
  });

  it("fails the refresh with a login hint when the token cannot be refreshed", async () => {
    mocks.refreshAccessToken.mockResolvedValueOnce(undefined);
    const { registration } = await track();
    await expect(registration.refresh(SIGNED_IN)).rejects.toThrow("opencode auth login google-antigravity");
  });

  it("closes the proxy on cleanup", async () => {
    const { added, cleanup } = await setup();
    expect(typeof cleanup).toBe("function");
    if (typeof cleanup === "function") await cleanup();
    await expect(generate(added.info.settings!.baseURL!)).rejects.toThrow();
  });
});

describe("browser sign-in (v1 callback page)", () => {
  const fakeListener = (callbackUrl?: string) => {
    let resolve!: (url: URL) => void;
    let reject!: (error: Error) => void;
    const waiting = new Promise<URL>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    waiting.catch(() => {});
    if (callbackUrl) resolve(new URL(callbackUrl));
    return {
      waitForCallback: vi.fn(() => waiting),
      close: vi.fn(async () => reject(new Error("OAuth listener closed before callback"))),
    };
  };

  const SUCCESS = {
    type: "success",
    refresh: "browser-refresh|project-2",
    access: "browser-access",
    expires: 1_950_000_000_000,
    email: "browser@example.com",
    projectId: "project-2",
  };

  it("waits for the local callback page and finishes the sign-in on its own", async () => {
    const listener = fakeListener("http://localhost:51121/oauth-callback?code=cb-code&state=cb-state");
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    mocks.exchangeAntigravity.mockResolvedValueOnce(SUCCESS);
    const { browser } = await track();

    const authorization = await browser.authorize({});
    expect(authorization.mode).toBe("auto");
    expect(authorization.url).toContain("accounts.google.com");
    expect(authorization.instructions).toContain("All set!");
    expect(authorization.instructions).toContain("copied to your clipboard");
    expect(mocks.startOAuthListener).toHaveBeenCalledWith({ timeoutMs: 9 * 60 * 1000 });

    const credential = await (authorization as AutoAuthorization).callback;
    expect(mocks.exchangeAntigravity).toHaveBeenCalledWith("cb-code", "cb-state");
    expect(mocks.persistAccountPool).toHaveBeenCalledWith([expect.objectContaining({ email: "browser@example.com" })], false);
    expect(credential).toMatchObject({ methodID: ANTIGRAVITY_METHOD_ID, access: "browser-access" });
    expect(listener.close).toHaveBeenCalled();
  });

  it("rejects when Google redirects back with an error instead of a code", async () => {
    const listener = fakeListener("http://localhost:51121/oauth-callback?error=access_denied&state=s");
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    const { browser } = await track();

    const authorization = (await browser.authorize({})) as AutoAuthorization;
    await expect(authorization.callback).rejects.toThrow("access_denied");
    expect(mocks.exchangeAntigravity).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalled();
  });

  it("falls back to pasting when port 51121 is busy", async () => {
    mocks.startOAuthListener.mockRejectedValueOnce(new Error("Port 51121 is already in use."));
    mocks.exchangeAntigravity.mockResolvedValueOnce(SUCCESS);
    const { browser } = await track();

    const authorization = await browser.authorize({});
    expect(authorization.mode).toBe("code");
    expect(authorization.instructions).toContain("Port 51121 is busy");
    const credential = await (authorization as CodeAuthorization).callback(
      "http://localhost:51121/oauth-callback?code=c&state=STATE123",
    );
    expect(credential.methodID).toBe(ANTIGRAVITY_METHOD_ID);
  });

  it("falls back to pasting in remote or WSL sessions without starting a listener", async () => {
    mocks.shouldSkipLocalServer.mockReturnValueOnce(true);
    const { browser } = await track();

    const authorization = await browser.authorize({});
    expect(authorization.mode).toBe("code");
    expect(authorization.instructions).toContain("remote or WSL session");
    expect(mocks.startOAuthListener).not.toHaveBeenCalled();
  });

  it("replaces an abandoned browser sign-in with a new one", async () => {
    const first = fakeListener();
    const second = fakeListener();
    mocks.startOAuthListener.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { browser } = await track();

    await browser.authorize({});
    expect(first.close).not.toHaveBeenCalled();
    await browser.authorize({});
    expect(first.close).toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it("frees the port when building the sign-in link fails", async () => {
    const listener = fakeListener();
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    mocks.authorizeAntigravity.mockRejectedValueOnce(new Error("network down"));
    const { browser } = await track();

    await expect(browser.authorize({})).rejects.toThrow("network down");
    expect(listener.close).toHaveBeenCalled();
  });

  it("closes a waiting listener on cleanup", async () => {
    const listener = fakeListener();
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    const { browser, cleanup } = await setup();

    await browser.authorize({});
    if (typeof cleanup === "function") await cleanup();
    expect(listener.close).toHaveBeenCalled();
  });
});

describe("model discovery", () => {
  const SUCCESS = {
    type: "success",
    refresh: "new-refresh|project-9",
    access: "new-access",
    expires: 1_900_000_000_000,
    email: "user@example.com",
    projectId: "project-9",
  };

  it("discovers Antigravity's models after a sign-in and reloads the catalog", async () => {
    mocks.exchangeAntigravity.mockResolvedValueOnce(SUCCESS);
    const { registration, providerReload } = await track();
    const authorization = await registration.authorize({});
    await authorization.callback("http://localhost:51121/oauth-callback?code=c&state=STATE123");
    await settle();

    expect(mocks.discoverRegistryModels).toHaveBeenCalledWith("new-access", "project-9");
    expect(providerReload).toHaveBeenCalled();
  });

  it("refreshes a list that was never discovered as soon as someone is signed in", async () => {
    const { providerReload } = await track(SIGNED_IN);
    await settle();
    expect(mocks.discoverRegistryModels).toHaveBeenCalledWith("access-token", "project-1");
    expect(providerReload).toHaveBeenCalled();
  });

  it("does not ask again while the discovered list is fresh", async () => {
    setRegistryModels(builtinRegistryModels(), Date.now());
    await track(SIGNED_IN);
    await settle();
    expect(mocks.discoverRegistryModels).not.toHaveBeenCalled();
  });

  it("does nothing before sign-in", async () => {
    await track();
    await settle();
    expect(mocks.discoverRegistryModels).not.toHaveBeenCalled();
  });

  it("keeps the current list when discovery fails", async () => {
    mocks.discoverRegistryModels.mockRejectedValueOnce(new Error("fetchAvailableModels 503"));
    const { providerReload, added } = await track(SIGNED_IN);
    await settle();
    expect(providerReload).not.toHaveBeenCalled();
    expect(added.models.length).toBe(builtinRegistryModels().length);
  });
});

describe("quota RPC", () => {
  it("registers the antigravity RPC and serves the quota snapshot", async () => {
    const { rpcRegister } = await track();
    expect(rpcRegister).toHaveBeenCalledTimes(1);
    const [definition, handlers] = rpcRegister.mock.calls[0]!;
    expect(definition.id).toBe("antigravity");

    await expect(handlers.quota!({})).resolves.toEqual({ fetchedAt: 1, accounts: [] });
    expect(mocks.quotaReporter).toHaveBeenLastCalledWith(false);
    await handlers.quota!({ refresh: true });
    expect(mocks.quotaReporter).toHaveBeenLastCalledWith(true);
  });
});

describe("plugin-run sign-in (re-authenticate from the TUI)", () => {
  it("preselects the account with login_hint and completes through the browser page", async () => {
    const listener = {
      waitForCallback: vi.fn(async () => new URL("http://localhost:51121/oauth-callback?code=c&state=s")),
      close: vi.fn(async () => {}),
    };
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    mocks.exchangeAntigravity.mockResolvedValueOnce({
      type: "success",
      refresh: "r|p",
      access: "a",
      expires: 1,
      email: "kelum@gmail.com",
      projectId: "p",
    });
    const { rpcRegister } = await track();
    const handlers = rpcRegister.mock.calls[0]![1] as Record<string, (input: unknown, call?: unknown) => Promise<any>>;

    const attempt = await handlers.signInStart!({ email: "kelum@gmail.com" });
    expect(attempt.mode).toBe("auto");
    expect(new URL(attempt.url).searchParams.get("login_hint")).toBe("kelum@gmail.com");
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(attempt.url);

    await settle();
    await expect(handlers.signInStatus!({ attemptID: attempt.attemptID })).resolves.toEqual({
      status: "complete",
      email: "kelum@gmail.com",
    });
    expect(mocks.persistAccountPool).toHaveBeenCalled();
    expect(mocks.quotaInvalidate).toHaveBeenCalled();
  });
});

describe("withLoginHint", () => {
  it("adds Google's login_hint only when an email is given", async () => {
    const { withLoginHint } = await import("./plugin");
    expect(new URL(withLoginHint("https://accounts.google.com/o?a=1", "me@gmail.com")).searchParams.get("login_hint")).toBe(
      "me@gmail.com",
    );
    expect(withLoginHint("https://accounts.google.com/o?a=1", undefined)).toBe("https://accounts.google.com/o?a=1");
  });
});

describe("browser sign-in fallback", () => {
  it("accepts the pasted redirect URL when the callback page couldn't be reached", async () => {
    const listener = {
      waitForCallback: vi.fn(() => new Promise<URL>(() => {})),
      close: vi.fn(async () => {}),
    };
    mocks.startOAuthListener.mockResolvedValueOnce(listener);
    mocks.exchangeAntigravity.mockResolvedValueOnce({
      type: "success",
      refresh: "r|p",
      access: "a",
      expires: 1,
      email: "kelum@gmail.com",
      projectId: "p",
    });
    const { rpcRegister } = await track();
    const handlers = rpcRegister.mock.calls[0]![1] as Record<string, (input: unknown, call?: unknown) => Promise<any>>;

    const attempt = await handlers.signInStart!({ email: "kelum@gmail.com" });
    await expect(
      handlers.signInComplete!(
        { attemptID: attempt.attemptID, code: "http://localhost:51121/oauth-callback?code=c&state=STATE123" },
        { error: vi.fn() },
      ),
    ).resolves.toEqual({ email: "kelum@gmail.com" });
    expect(mocks.exchangeAntigravity).toHaveBeenCalledWith("c", "STATE123");
    expect(listener.close).toHaveBeenCalled();
  });
});
