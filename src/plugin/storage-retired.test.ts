import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashRefreshToken,
  loadAccounts,
  retireRefreshTokens,
  saveAccounts,
  saveAccountsReplace,
  type AccountStorageV4,
} from "./storage";

let dir: string;
const original = process.env.OPENCODE_CONFIG_DIR;
const poolPath = () => join(dir, "antigravity-accounts.json");
const readRaw = () => JSON.parse(readFileSync(poolPath(), "utf8")) as AccountStorageV4;
const tokens = (storage: AccountStorageV4 | null) => storage?.accounts.map((account) => account.refreshToken) ?? [];

const pool = (accounts: Array<{ email: string; token: string; lastUsed?: number }>, extra: Partial<AccountStorageV4> = {}) =>
  ({
    version: 4,
    accounts: accounts.map(({ email, token, lastUsed = 1 }) => ({ email, refreshToken: token, addedAt: 1, lastUsed })),
    activeIndex: 0,
    ...extra,
  }) satisfies AccountStorageV4;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antigravity-retired-"));
  process.env.OPENCODE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("retired refresh tokens", () => {
  it("keeps a stale save from merging a replaced token back as a second account", async () => {
    writeFileSync(poolPath(), JSON.stringify(pool([{ email: "a@gmail.com", token: "new" }], { retiredTokenHashes: [hashRefreshToken("old")] })));
    // An account manager that loaded the pool before re-authentication still holds "old".
    await saveAccounts(pool([{ email: "a@gmail.com", token: "old", lastUsed: 99 }]));
    expect(tokens(readRaw())).toEqual(["new"]);
  });

  it("collapses the same email under two tokens when nothing was retired", async () => {
    writeFileSync(poolPath(), JSON.stringify(pool([{ email: "a@gmail.com", token: "t1", lastUsed: 5 }])));
    await saveAccounts(pool([{ email: "a@gmail.com", token: "t2", lastUsed: 9 }]));
    expect(tokens(readRaw())).toEqual(["t2"]);
  });

  it("lets a sign-in bring back a token that had been retired", async () => {
    writeFileSync(poolPath(), JSON.stringify(pool([], { retiredTokenHashes: [hashRefreshToken("again")] })));
    await saveAccounts(pool([{ email: "a@gmail.com", token: "again" }]), { unretireTokens: ["again"] });
    const raw = readRaw();
    expect(tokens(raw)).toEqual(["again"]);
    expect(raw.retiredTokenHashes ?? []).not.toContain(hashRefreshToken("again"));
  });

  it("keeps the retired list across replacing writes and never writes a retired token", async () => {
    writeFileSync(poolPath(), JSON.stringify(pool([{ email: "a@gmail.com", token: "a" }], { retiredTokenHashes: [hashRefreshToken("gone")] })));
    await saveAccountsReplace(pool([{ email: "a@gmail.com", token: "a" }, { email: "b@gmail.com", token: "gone" }]));
    const raw = readRaw();
    expect(tokens(raw)).toEqual(["a"]);
    expect(raw.retiredTokenHashes).toContain(hashRefreshToken("gone"));
  });

  it("retires tokens on demand and stores only fingerprints", async () => {
    writeFileSync(poolPath(), JSON.stringify(pool([{ email: "a@gmail.com", token: "secret-a" }, { email: "b@gmail.com", token: "b" }])));
    await retireRefreshTokens(["secret-a"]);
    const text = readFileSync(poolPath(), "utf8");
    expect(text).not.toContain("secret-a");
    expect(tokens(await loadAccounts())).toEqual(["b"]);
  });

  it("filters retired tokens on load", async () => {
    writeFileSync(
      poolPath(),
      JSON.stringify(pool([{ email: "a@gmail.com", token: "x" }, { email: "b@gmail.com", token: "y" }], { retiredTokenHashes: [hashRefreshToken("x")] })),
    );
    expect(tokens(await loadAccounts())).toEqual(["y"]);
  });
});
