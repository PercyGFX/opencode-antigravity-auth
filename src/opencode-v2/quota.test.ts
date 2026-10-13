import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountQuotaResult } from "../plugin/quota";
import type { PluginClient } from "../plugin/types";
import { accountLevel, formatPercent, formatReset, limitLevel, sortAccounts } from "./quota-format";
import { createQuotaReporter, toQuotaAccount } from "./quota";

const RESET_SOON = "2026-10-13T10:26:29Z";
const RESET_LATER = "2026-10-13T10:38:37Z";

const result = (index: number, overrides: Partial<AccountQuotaResult> = {}): AccountQuotaResult => ({
  index,
  email: `user${index + 1}@gmail.com`,
  status: "ok",
  quota: {
    modelCount: 3,
    groups: {
      "gemini-pro": { remainingFraction: 0.991, resetTime: RESET_LATER, modelCount: 1 },
      "gemini-flash": { remainingFraction: 0.5, resetTime: RESET_SOON, modelCount: 1 },
      claude: { remainingFraction: 1, resetTime: RESET_LATER, modelCount: 1 },
    },
  },
  ...overrides,
});

describe("toQuotaAccount", () => {
  it("merges the Gemini buckets (lowest remaining, earliest reset) and keeps Claude separate", () => {
    expect(toQuotaAccount(result(0), ["Gemini"])).toEqual({
      index: 0,
      email: "user1@gmail.com",
      enabled: true,
      inUse: ["Gemini"],
      limits: [
        { name: "Gemini", remainingPercent: 50, resetAt: Date.parse(RESET_SOON) },
        { name: "Claude & GPT-OSS", remainingPercent: 100, resetAt: Date.parse(RESET_LATER) },
      ],
    });
  });

  it("reports errors instead of limits", () => {
    expect(toQuotaAccount(result(1, { status: "error", error: "Token refresh failed", quota: undefined }), [])).toEqual({
      index: 1,
      email: "user2@gmail.com",
      enabled: true,
      inUse: [],
      limits: [],
      error: "Token refresh failed",
    });
  });
});

describe("createQuotaReporter", () => {
  let dir: string;
  const original = process.env.OPENCODE_CONFIG_DIR;
  const client = {} as PluginClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antigravity-quota-"));
    process.env.OPENCODE_CONFIG_DIR = dir;
    writeFileSync(
      join(dir, "antigravity-accounts.json"),
      JSON.stringify({
        version: 4,
        accounts: [
          { email: "user1@gmail.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
          { email: "user2@gmail.com", refreshToken: "r2", addedAt: 1, lastUsed: 1 },
          { email: "user3@gmail.com", refreshToken: "r3", addedAt: 1, lastUsed: 1, enabled: false },
        ],
        activeIndex: 0,
        activeIndexByFamily: { gemini: 1, claude: 0 },
      }),
    );
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchQuota = () =>
    vi.fn(async () => [result(0), result(1), result(2, { disabled: true })]);

  it("marks which account serves Gemini and which serves Claude, never a disabled one", async () => {
    const report = createQuotaReporter(client, "google-antigravity", fetchQuota());
    const snapshot = await report.snapshot();
    expect(snapshot.accounts.map((account) => [account.email, account.inUse, account.enabled])).toEqual([
      ["user1@gmail.com", ["Claude"], true],
      ["user2@gmail.com", ["Gemini"], true],
      ["user3@gmail.com", [], false],
    ]);
  });

  it("serves a cached snapshot for a minute unless a refresh is forced", async () => {
    const fetcher = fetchQuota();
    const report = createQuotaReporter(client, "google-antigravity", fetcher);
    await report.snapshot();
    await report.snapshot();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await report.snapshot(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    report.invalidate();
    await report.snapshot();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shares one fetch between concurrent callers", async () => {
    const fetcher = fetchQuota();
    const report = createQuotaReporter(client, "google-antigravity", fetcher);
    await Promise.all([report.snapshot(true), report.snapshot(true), report.snapshot(true)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("quota formatting", () => {
  const now = Date.parse("2026-10-13T05:38:37Z");

  it("formats the time to reset", () => {
    expect(formatReset(Date.parse(RESET_LATER), now)).toBe("5h 00m");
    expect(formatReset(now + 12 * 60_000, now)).toBe("12m");
    expect(formatReset(now - 1, now)).toBe("now");
    expect(formatReset(null, now)).toBe("");
  });

  it("formats and grades the remaining share", () => {
    expect(formatPercent({ name: "Gemini", remainingPercent: 99.1, resetAt: null })).toBe("99%");
    expect(formatPercent({ name: "Gemini", remainingPercent: null, resetAt: null })).toBe("?");
    expect(limitLevel({ name: "Gemini", remainingPercent: 8, resetAt: null })).toBe("critical");
    expect(limitLevel({ name: "Gemini", remainingPercent: 25, resetAt: null })).toBe("low");
    expect(limitLevel({ name: "Gemini", remainingPercent: 80, resetAt: null })).toBe("ok");
  });

  it("colors an account by its worst limit", () => {
    const account = toQuotaAccount(result(0), []);
    expect(accountLevel(account)).toBe("ok");
    expect(accountLevel({ ...account, limits: [{ name: "Gemini", remainingPercent: 5, resetAt: null }] })).toBe("critical");
    expect(accountLevel({ ...account, enabled: false })).toBe("unknown");
  });

  it("lists accounts in use first, disabled ones last", () => {
    const base = toQuotaAccount(result(0), []);
    const accounts = [
      { ...base, email: "a", enabled: false },
      { ...base, email: "b" },
      { ...base, email: "c", inUse: ["Gemini"] },
    ];
    expect(sortAccounts(accounts).map((account) => account.email)).toEqual(["c", "b", "a"]);
  });

  it("puts the account serving the selected model's group first", () => {
    const base = toQuotaAccount(result(0), []);
    const accounts = [
      { ...base, email: "claude", inUse: ["Claude"] },
      { ...base, email: "gemini", inUse: ["Gemini"] },
    ];
    expect(sortAccounts(accounts, "Gemini").map((account) => account.email)).toEqual(["gemini", "claude"]);
    expect(sortAccounts(accounts, "Claude").map((account) => account.email)).toEqual(["claude", "gemini"]);
  });
});
