import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountManager } from "../plugin/accounts";
import type { AccountStorageV4 } from "../plugin/storage";
import { AccountNotFoundError, poolAuth, removeAccount, setAccountEnabled } from "./accounts";

const POOL: AccountStorageV4 = {
  version: 4,
  accounts: [
    { email: "a@gmail.com", refreshToken: "token-a", projectId: "project-a", addedAt: 1, lastUsed: 1 },
    { email: "b@gmail.com", refreshToken: "token-b", addedAt: 1, lastUsed: 1 },
    { email: "c@gmail.com", refreshToken: "token-c", addedAt: 1, lastUsed: 1 },
  ],
  activeIndex: 2,
  activeIndexByFamily: { claude: 0, gemini: 2 },
};

let dir: string;
const original = process.env.OPENCODE_CONFIG_DIR;
const poolPath = () => join(dir, "antigravity-accounts.json");
const readPool = () => JSON.parse(readFileSync(poolPath(), "utf8")) as AccountStorageV4;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antigravity-accounts-"));
  process.env.OPENCODE_CONFIG_DIR = dir;
  writeFileSync(poolPath(), JSON.stringify(POOL));
});
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("account actions without a running pipeline", () => {
  it("disables and re-enables an account in the file", async () => {
    await setAccountEnabled(null, 1, "b@gmail.com", false);
    expect(readPool().accounts[1]?.enabled).toBe(false);
    await setAccountEnabled(null, 1, "b@gmail.com", true);
    expect(readPool().accounts[1]?.enabled).toBe(true);
  });

  it("removes an account and shifts the active indexes past it", async () => {
    await expect(removeAccount(null, 0, "a@gmail.com")).resolves.toBe(2);
    const pool = readPool();
    expect(pool.accounts.map((account) => account.email)).toEqual(["b@gmail.com", "c@gmail.com"]);
    expect(pool.activeIndex).toBe(1);
    expect(pool.activeIndexByFamily).toEqual({ claude: 0, gemini: 1 });
  });

  it("finds the account by email when the list shifted", async () => {
    await removeAccount(null, 0, "c@gmail.com");
    expect(readPool().accounts.map((account) => account.email)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });

  it("refuses unknown accounts", async () => {
    await expect(removeAccount(null, 0, "nobody@gmail.com")).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(setAccountEnabled(null, 5, "nobody@gmail.com", false)).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe("account actions through the running account manager", () => {
  const manager = () => new AccountManager(undefined, structuredClone(POOL));

  it("disables through the manager so rotation skips the account right away", async () => {
    const live = manager();
    await setAccountEnabled(live, 2, "c@gmail.com", false);
    expect(live.getAccounts()[2]?.enabled).toBe(false);
    expect(readPool().accounts[2]?.enabled).toBe(false);
  });

  it("removes through the manager and replaces the file, so the merge cannot bring it back", async () => {
    const live = manager();
    await expect(removeAccount(live, 1, "b@gmail.com")).resolves.toBe(2);
    expect(live.getAccounts().map((account) => account.email)).toEqual(["a@gmail.com", "c@gmail.com"]);
    expect(readPool().accounts.map((account) => account.email)).toEqual(["a@gmail.com", "c@gmail.com"]);
  });
});

describe("poolAuth", () => {
  it("keeps opencode's login while its account is in the pool", async () => {
    const login = { type: "oauth" as const, refresh: "token-b|project-b", access: "access", expires: 1 };
    await expect(poolAuth(login)).resolves.toBe(login);
  });

  it("swaps in a pool account once the login's account was removed", async () => {
    const login = { type: "oauth" as const, refresh: "token-removed|project-x", access: "access", expires: 1 };
    await expect(poolAuth(login)).resolves.toEqual({ type: "oauth", refresh: "token-a|project-a" });
  });

  it("skips disabled pool accounts when swapping", async () => {
    writeFileSync(
      poolPath(),
      JSON.stringify({ ...POOL, accounts: POOL.accounts.map((account, index) => ({ ...account, enabled: index === 2 })) }),
    );
    const login = { type: "oauth" as const, refresh: "token-removed", access: "access", expires: 1 };
    // formatRefreshParts() keeps the separator when there is no project ID.
    await expect(poolAuth(login)).resolves.toEqual({ type: "oauth", refresh: "token-c|" });
  });

  it("keeps the login when the pool is empty", async () => {
    rmSync(poolPath());
    const login = { type: "oauth" as const, refresh: "token-new", access: "access", expires: 1 };
    await expect(poolAuth(login)).resolves.toBe(login);
  });
});

describe("stale account managers", () => {
  it("can't bring back an account removed through another manager", async () => {
    const live = new AccountManager(undefined, structuredClone(POOL));
    const stale = new AccountManager(undefined, structuredClone(POOL)); // e.g. another opencode location
    await removeAccount(live, 1, "b@gmail.com");
    await stale.saveToDisk();
    expect(readPool().accounts.map((account) => account.email)).toEqual(["a@gmail.com", "c@gmail.com"]);
  });

  it("can't bring back a removed account after a removal without a running pipeline", async () => {
    const stale = new AccountManager(undefined, structuredClone(POOL));
    await removeAccount(null, 2, "c@gmail.com");
    await stale.saveToDisk();
    expect(readPool().accounts.map((account) => account.email)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });
});
