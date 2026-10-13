#!/usr/bin/env node
/**
 * Lists the models Antigravity currently recommends for your account, the same list the plugin
 * discovers automatically. Prints model metadata only, never tokens.
 *
 *   node scripts/list-models.mjs            # table
 *   node scripts/list-models.mjs --json     # JSON (the shape the plugin caches)
 *   node scripts/list-models.mjs --all      # include models outside the Recommended list
 *   node scripts/list-models.mjs --account 2  # check the 2nd account in the pool
 *   node scripts/list-models.mjs --path /path/to/antigravity-accounts.json
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CLOUD_CODE_BASE = "https://cloudcode-pa.googleapis.com";
const LEGACY_UA = "antigravity/1.15.8 windows/amd64";
const HUB_UA = "antigravity/hub/2.8.0 (aidev_client; os_type=windows; arch=amd64; cl=963137146)";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showAll = args.includes("--all");
const pathIndex = args.indexOf("--path");
const configDir =
  process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
const accountsPath = pathIndex >= 0 && args[pathIndex + 1] ? args[pathIndex + 1] : join(configDir, "antigravity-accounts.json");

const accounts = JSON.parse(readFileSync(accountsPath, "utf8")).accounts || [];
const accountIndex = args.indexOf("--account");
const account =
  accountIndex >= 0 ? accounts[Number(args[accountIndex + 1]) - 1] : accounts.find((entry) => entry.enabled !== false);
if (!account) {
  console.error(accountIndex >= 0 ? "No account with that number." : "No enabled accounts. Sign in first.");
  process.exit(1);
}

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }),
});
if (!tokenResponse.ok) {
  console.error(`Token refresh failed (${tokenResponse.status}). Sign in again.`);
  process.exit(1);
}
const accessToken = (await tokenResponse.json()).access_token;

const post = async (method, userAgent, body) => {
  const response = await fetch(`${CLOUD_CODE_BASE}/v1internal:${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
};

const assist = await post("loadCodeAssist", LEGACY_UA, { metadata: { ideType: "ANTIGRAVITY" } }).catch(() => ({}));
const project =
  (typeof assist.cloudaicompanionProject === "string" ? assist.cloudaicompanionProject : assist.cloudaicompanionProject?.id) ||
  account.managedProjectId ||
  account.projectId ||
  "";
const body = project ? { project } : {};
const hub = await post("fetchAvailableModels", HUB_UA, body);
const legacy = await post("fetchAvailableModels", LEGACY_UA, body).catch(() => ({ models: {} }));

const recommended = (hub.agentModelSorts ?? []).flatMap((sort) => (sort.groups ?? []).flatMap((group) => group.modelIds ?? []));
const ids = showAll ? Object.keys(hub.models ?? {}) : recommended;
const rows = ids.map((id) => {
  const info = hub.models?.[id] ?? {};
  return {
    id,
    displayName: info.displayName ?? id,
    modelProvider: info.modelProvider,
    supportsImages: Boolean(info.supportsImages),
    supportsThinking: Boolean(info.supportsThinking),
    thinkingBudget: info.thinkingBudget,
    maxTokens: info.maxTokens,
    maxOutputTokens: info.maxOutputTokens,
    hubOnly: !(id in (legacy.models ?? {})),
    notice: info.tagDescription,
    tag: info.tagTitle,
  };
});

if (asJson) {
  console.log(JSON.stringify({ defaultAgentModelId: hub.defaultAgentModelId, deprecatedModelIds: hub.deprecatedModelIds, models: rows }, null, 2));
} else {
  for (const row of rows) {
    const flags = [row.hubOnly ? "hub UA" : "", row.supportsImages ? "images" : "", row.supportsThinking ? "thinking" : ""]
      .filter(Boolean)
      .join(", ");
    console.log(`${row.id.padEnd(28)} ${row.displayName.padEnd(30)} ${String(row.maxTokens ?? "?").padStart(8)} / ${String(row.maxOutputTokens ?? "?").padEnd(6)} ${flags}`);
    if (row.notice) console.log(`${"".padEnd(28)} ! ${row.tag ? `${row.tag}: ` : ""}${row.notice}`);
  }
}
