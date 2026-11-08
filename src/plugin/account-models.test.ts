import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @opencode-ai/plugin 0.15 ships extensionless ESM imports that only Bun resolves.
vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

import { applyPoolModels, discoverPoolModels, type PoolModelsAccount } from "./account-models";
import { AccountManager } from "./accounts";
import type { AccountModelDiscovery } from "./model-discovery";
import {
  buildRegistryModels,
  getRegistryModels,
  mergeRegistryModels,
  resetRegistryForTests,
  type AvailableModelInfo,
  type AvailableModelsResponse,
} from "./model-registry";
import { loadAccounts, saveAccounts, updateAccountModels, type AccountStorageV4 } from "./storage";
import type { PluginClient } from "./types";

const info = (displayName: string, extra: Partial<AvailableModelInfo> = {}): AvailableModelInfo => ({
  displayName,
  supportsImages: true,
  supportsThinking: true,
  maxTokens: 1_000_000,
  maxOutputTokens: 64_000,
  ...extra,
});

const response = (models: Record<string, AvailableModelInfo>): AvailableModelsResponse => ({
  models,
  agentModelSorts: [{ groups: [{ modelIds: Object.keys(models) }] }],
});

// Trimmed `fetchAvailableModels` answers (hub User-Agent), shaped like the live ones on 2026-11-09.
const FREE = response({
  "gemini-3.8-flash-high": info("Gemini 3.8 Flash (High)"),
  "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)"),
  "claude-opus-4-6-thinking": info("Claude Opus 4.6 (Thinking)"),
  "gemini-4-argon-disabled": info("Gemini 4 Argon", {
    tagTitle: "Unavailable",
    tagDescription: "Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers.",
  }),
});
const PRO = response({
  "gemini-4-argon-medium": info("Gemini 4 Argon (Medium)"),
  "gemini-4-argon-high": info("Gemini 4 Argon (High)"),
  "gemini-4-argon-low": info("Gemini 4 Argon (Low)"),
  "gemini-3.8-flash-high": info("Gemini 3.8 Flash (High)"),
  "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)"),
  "claude-opus-5-5-low": info("Claude Opus 5.5 (Low)"),
  "claude-opus-5-5-high": info("Claude Opus 5.5 (High)"),
});

const discovery = (answer: AvailableModelsResponse): AccountModelDiscovery => ({
  models: buildRegistryModels(answer),
  available: Object.keys(answer.models ?? {}),
});
const FREE_DISCOVERY = discovery(FREE);
const PRO_DISCOVERY = discovery(PRO);

const client = {} as PluginClient;

let configDir: string;
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "antigravity-account-models-"));
  process.env.OPENCODE_CONFIG_DIR = configDir;
  resetRegistryForTests(mergeRegistryModels([FREE_DISCOVERY.models, PRO_DISCOVERY.models]));
});

afterEach(() => {
  resetRegistryForTests();
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

const pool = (overrides: Partial<AccountStorageV4> = {}): AccountStorageV4 => ({
  version: 4,
  accounts: [
    { email: "free@example.com", refreshToken: "free", addedAt: 1, lastUsed: 0, availableModels: FREE_DISCOVERY.available },
    { email: "pro@example.com", refreshToken: "pro", addedAt: 1, lastUsed: 0, availableModels: PRO_DISCOVERY.available },
  ],
  activeIndex: 0,
  ...overrides,
});

describe("catalog across plans", () => {
  it("offers every model some account has, without the free plan's disabled Argon placeholder", () => {
    expect(getRegistryModels().map((model) => model.id).sort()).toEqual([
      "claude-opus-4-6-thinking",
      "claude-opus-5.5",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ]);
    const argon = getRegistryModels().find((model) => model.id === "gemini-4-argon");
    expect(argon?.variants.map((variant) => variant.tier)).toEqual(["low", "medium", "high"]);
  });

  it("combines tiers and hub-only flags when accounts report the same model", () => {
    const flash = (hubOnly: boolean, tiers: Array<"low" | "high">) => ({
      ...FREE_DISCOVERY.models.find((model) => model.id === "gemini-3.8-flash")!,
      variants: tiers.map((tier) => ({ tier, upstreamId: `gemini-3.8-flash-${tier}`, hubOnly })),
    });
    const [merged] = mergeRegistryModels([[flash(false, ["high"])], [flash(true, ["low", "high"])]]);
    expect(merged?.variants).toEqual([
      { tier: "low", upstreamId: "gemini-3.8-flash-low", hubOnly: true },
      { tier: "high", upstreamId: "gemini-3.8-flash-high", hubOnly: true },
    ]);
  });
});

describe("routing by account plan", () => {
  it("sends each model only to accounts that have it", () => {
    const manager = new AccountManager(undefined, pool());

    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-opus-5.5")?.email).toBe("pro@example.com");
    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-opus-4-6-thinking")?.email).toBe(
      "free@example.com",
    );
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-4-argon", "hybrid")?.email).toBe(
      "pro@example.com",
    );
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-3.8-flash")).not.toBeNull();
  });

  it("waits for an account that has the model instead of falling back to one that lacks it", () => {
    const manager = new AccountManager(undefined, pool());
    const pro = manager.getAccounts()[1]!;
    manager.markRateLimited(pro, 60_000, "claude");

    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-opus-5.5")).toBeNull();
    expect(manager.getMinWaitTimeForFamily("claude", "antigravity-claude-opus-5.5")).toBeGreaterThan(0);
    // The free account is still fine for the models it has.
    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-opus-4-6-thinking")?.email).toBe(
      "free@example.com",
    );
  });

  it("reports when no enabled account has the model", () => {
    const manager = new AccountManager(undefined, pool());
    manager.setAccountEnabled(1, false);

    expect(manager.getEnabledAccountsForModel("antigravity-gemini-4-argon")).toEqual([]);
    expect(manager.getEnabledAccountsForModel("antigravity-gemini-3.8-flash")).toHaveLength(1);
  });

  it("does not filter accounts whose models are unknown, or models the registry does not know", () => {
    const stored = pool();
    delete stored.accounts[0]!.availableModels;
    const manager = new AccountManager(undefined, stored);

    expect(manager.getEnabledAccountsForModel("antigravity-claude-opus-5.5")).toHaveLength(2);
    expect(manager.getEnabledAccountsForModel("gemini-2.5-pro")).toHaveLength(2);
  });
});

describe("discoverPoolModels / applyPoolModels", () => {
  const accounts: PoolModelsAccount[] = [
    { refreshToken: "free", email: "free@example.com", access: "access-free", expires: Date.now() + 3_600_000 },
    { refreshToken: "pro", email: "pro@example.com", access: "access-pro", expires: Date.now() + 3_600_000 },
  ];
  const discover = async (accessToken: string) => (accessToken === "access-pro" ? PRO_DISCOVERY : FREE_DISCOVERY);

  it("stores each account's list on disk and in the running account manager", async () => {
    const stored = pool();
    for (const account of stored.accounts) delete account.availableModels;
    await saveAccounts(stored);
    const manager = new AccountManager(undefined, (await loadAccounts())!);

    const results = await discoverPoolModels(accounts, client, "google", discover);
    expect(await applyPoolModels(results, manager, 1234)).toBe(true);

    const onDisk = (await loadAccounts())!.accounts;
    expect(onDisk.map((account) => account.availableModelsUpdatedAt)).toEqual([1234, 1234]);
    expect(onDisk[1]!.availableModels).toContain("claude-opus-5-5-low");
    expect(onDisk[0]!.availableModels).not.toContain("claude-opus-5-5-low");
    expect(manager.getEnabledAccountsForModel("antigravity-claude-opus-5.5").map((account) => account.email)).toEqual([
      "pro@example.com",
    ]);
  });

  it("keeps the models of an account whose discovery failed", async () => {
    const failing = async (accessToken: string) => {
      if (accessToken === "access-pro") throw new Error("fetchAvailableModels 503");
      return FREE_DISCOVERY;
    };
    const withStoredList = accounts.map((account) =>
      account.refreshToken === "pro" ? { ...account, availableModels: PRO_DISCOVERY.available } : account,
    );

    const results = await discoverPoolModels(withStoredList, client, "google", failing);
    expect(results[1]?.error).toContain("503");
    expect(await applyPoolModels(results, null)).toBe(true);
    expect(getRegistryModels().map((model) => model.id)).toContain("claude-opus-5.5");
  });

  it("changes nothing when no account answered", async () => {
    const before = getRegistryModels();
    const results = await discoverPoolModels(accounts, client, "google", async () => {
      throw new Error("offline");
    });
    expect(await applyPoolModels(results, null)).toBe(false);
    expect(getRegistryModels()).toBe(before);
  });
});

describe("isAccountSuspendedError", () => {
  it("recognizes Google's Terms of Service suspension and nothing else", async () => {
    const { isAccountSuspendedError } = await import("../plugin");
    const suspended = JSON.stringify({
      error: {
        code: 403,
        message:
          "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
        status: "PERMISSION_DENIED",
      },
    });
    expect(isAccountSuspendedError(suspended)).toBe(true);
    expect(isAccountSuspendedError('{"error":{"code":403,"message":"The caller does not have permission"}}')).toBe(false);
  });
});

describe("stored model lists", () => {
  it("survive a save from an account manager loaded before the last discovery", async () => {
    const stored = pool();
    for (const account of stored.accounts) delete account.availableModels;
    await saveAccounts(stored);
    await updateAccountModels([{ refreshToken: "pro", availableModels: PRO_DISCOVERY.available, availableModelsUpdatedAt: 2 }]);

    // A manager that never saw the list, and one holding an older list.
    await saveAccounts(stored);
    const older = pool();
    older.accounts[1]!.availableModels = ["claude-opus-4-6-thinking"];
    older.accounts[1]!.availableModelsUpdatedAt = 1;
    await saveAccounts(older);

    const pro = (await loadAccounts())!.accounts[1]!;
    expect(pro.availableModelsUpdatedAt).toBe(2);
    expect(pro.availableModels).toEqual(PRO_DISCOVERY.available);
  });
});
