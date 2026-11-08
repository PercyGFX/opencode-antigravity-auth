/**
 * Checks whether each pool account can still use Antigravity, including disabled ones.
 *
 * Google's model and quota lookups keep answering for suspended accounts, so this sends each
 * account one tiny request (a one-word reply from Gemini 3.8 Flash). It uses a few tokens of
 * quota per working account. It reads the pool file only; nothing is changed.
 *
 *   node scripts/check-accounts.mjs
 *   node scripts/check-accounts.mjs --account 2                 # one account (1-based)
 *   node scripts/check-accounts.mjs --path /path/to/antigravity-accounts.json
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
// Keep in step with ANTIGRAVITY_HUB_VERSION / ANTIGRAVITY_HUB_CL in src/constants.ts.
const HUB_UA = "antigravity/hub/2.23.0 (aidev_client; os_type=windows; arch=amd64; cl=1007378935)";
const TEST_MODEL = "gemini-3.8-flash-low";

const args = process.argv.slice(2);
const pathIndex = args.indexOf("--path");
const accountIndex = args.indexOf("--account");
const configDir =
  process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
const accountsPath = pathIndex >= 0 && args[pathIndex + 1] ? args[pathIndex + 1] : join(configDir, "antigravity-accounts.json");

let accounts = (JSON.parse(readFileSync(accountsPath, "utf8")).accounts || []).map((account, index) => ({ ...account, number: index + 1 }));
if (accountIndex >= 0) {
  const wanted = Number.parseInt(args[accountIndex + 1] ?? "", 10);
  accounts = accounts.filter((account) => account.number === wanted);
}

async function accessToken(refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`sign-in expired or revoked (${body.error ?? response.status})`);
  return body.access_token;
}

async function post(path, token, body) {
  const response = await fetch(`${ENDPOINT}/v1internal:${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": HUB_UA },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function check(account) {
  const token = await accessToken(account.refreshToken);
  let project = account.managedProjectId;
  if (!project) {
    const load = await post("loadCodeAssist", token, { metadata: { ideType: "ANTIGRAVITY" } });
    const value = load.body.cloudaicompanionProject;
    project = typeof value === "string" ? value : value?.id;
  }
  if (!project) return "⚠️  no project (account not set up for Antigravity)";

  const result = await post("generateContent", token, {
    project,
    model: TEST_MODEL,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${randomUUID()}`,
    request: { contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: ok" }] }], generationConfig: { maxOutputTokens: 64 } },
  });
  const message = result.body.error?.message ?? "";
  if (result.status === 200) return "✅ working";
  if (/violation of terms of service/i.test(message)) return "❌ suspended (Terms of Service)";
  if (/verify your account/i.test(message)) return "⚠️  needs verification";
  if (result.status === 429) return "⏳ rate-limited or out of quota (not suspended)";
  return `⚠️  ${result.status} ${message.slice(0, 120)}`;
}

for (const account of accounts) {
  const label = `${account.number}. ${account.email ?? "(no email)"}`.padEnd(32);
  const state = account.enabled === false ? "disabled" : "enabled ";
  const status = await check(account).catch((error) => `⚠️  ${error.message}`);
  console.log(`${label} ${state}  ${status}`);
}
