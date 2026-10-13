import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @opencode-ai/plugin 0.15 ships extensionless ESM imports that only Bun resolves.
vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

import { persistAccountPool } from "../plugin";
import { AccountManager } from "../plugin/accounts";
import type { AccountStorageV4 } from "../plugin/storage";

let dir: string;
const original = process.env.OPENCODE_CONFIG_DIR;
const poolPath = () => join(dir, "antigravity-accounts.json");
const readPool = () => JSON.parse(readFileSync(poolPath(), "utf8")) as AccountStorageV4;

const POOL: AccountStorageV4 = {
  version: 4,
  accounts: [
    { email: "a@gmail.com", refreshToken: "a-old", addedAt: 1, lastUsed: 1 },
    { email: "b@gmail.com", refreshToken: "b-token", addedAt: 1, lastUsed: 1 },
  ],
  activeIndex: 0,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antigravity-reauth-"));
  process.env.OPENCODE_CONFIG_DIR = dir;
  writeFileSync(poolPath(), JSON.stringify(POOL));
});
afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

describe("re-authenticating an account", () => {
  it("replaces its token for good, even when a stale account manager saves afterwards", async () => {
    const stale = new AccountManager(undefined, structuredClone(POOL)); // loaded before re-authentication
    stale.getAccounts()[0]!.lastUsed = Date.now() + 60_000; // and it kept serving requests

    await persistAccountPool(
      [{ type: "success", refresh: "a-new|project-a", access: "x", expires: 1, email: "a@gmail.com", projectId: "project-a" }],
      false,
    );
    await stale.saveToDisk();

    const pool = readPool();
    expect(pool.accounts.map((account) => [account.email, account.refreshToken])).toEqual([
      ["a@gmail.com", "a-new"],
      ["b@gmail.com", "b-token"],
    ]);
  });
});
