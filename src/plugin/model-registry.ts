/**
 * Antigravity model registry.
 *
 * The models this plugin offers come from Antigravity itself: `fetchAvailableModels` returns a
 * "Recommended" list with display names, limits and capabilities. The registry turns that list
 * into catalog entries (one entry per model, Low/Medium/High tiers as variants) and answers which
 * upstream model ID and User-Agent a request needs. New models therefore appear, and retired ones
 * disappear, without code changes.
 *
 * Until a discovery has run (before sign-in, offline), a built-in snapshot is used. The latest
 * discovery is cached on disk so later starts have it immediately.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createLogger } from "./logger";

const log = createLogger("model-registry");

export type ModelTier = "minimal" | "low" | "medium" | "high";
export type ModelVendor = "google" | "anthropic" | "openai" | "other";

const TIER_ORDER: readonly ModelTier[] = ["minimal", "low", "medium", "high"];
const TIER_SUFFIX = /^(.*\S)\s+\((minimal|low|medium|high)\)$/i;

/** One entry of `fetchAvailableModels().models`, reduced to what the registry uses. */
export interface AvailableModelInfo {
  displayName?: string;
  modelProvider?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  tagTitle?: string;
  tagDescription?: string;
}

/** The parts of a `fetchAvailableModels` response the registry reads. */
export interface AvailableModelsResponse {
  models?: Record<string, AvailableModelInfo | undefined>;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
}

export interface RegistryVariant {
  tier: ModelTier;
  upstreamId: string;
  /** Only served to the current Antigravity client (hub User-Agent). */
  hubOnly: boolean;
}

export interface RegistryModel {
  /** Catalog ID without the `antigravity-` prefix, e.g. `gemini-3.8-flash`, `claude-opus-4-6-thinking`. */
  id: string;
  /** Display name without the tier, e.g. `Gemini 3.8 Flash`. */
  name: string;
  vendor: ModelVendor;
  /** Upstream ID used when no tier is requested (Antigravity's first-listed tier). */
  upstreamId: string;
  hubOnly: boolean;
  /** Tiers that map to their own upstream IDs; empty for single-ID models. */
  variants: RegistryVariant[];
  supportsImages: boolean;
  supportsThinking: boolean;
  contextLimit: number;
  outputLimit: number;
  /** Antigravity's notice, e.g. "Leaving Soon: Start using Gemini 3.8 Flash". */
  notice?: string;
  leavingSoon: boolean;
}

export interface UpstreamModelResolution {
  model: RegistryModel;
  upstreamId: string;
  tier?: ModelTier;
  hubOnly: boolean;
}

const FALLBACK_CONTEXT = 200_000;
const FALLBACK_OUTPUT = 32_000;

function vendorOf(modelProvider: string | undefined, id: string): ModelVendor {
  const provider = (modelProvider ?? "").toUpperCase();
  if (provider.includes("GOOGLE") || id.startsWith("gemini")) return "google";
  if (provider.includes("ANTHROPIC") || id.startsWith("claude")) return "anthropic";
  if (provider.includes("OPENAI") || id.startsWith("gpt")) return "openai";
  return "other";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function recommendedIds(response: AvailableModelsResponse): string[] {
  const ids: string[] = [];
  for (const sort of response.agentModelSorts ?? []) {
    for (const group of sort.groups ?? []) {
      for (const id of group.modelIds ?? []) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Builds registry models from a `fetchAvailableModels` response made with the hub User-Agent.
 * `legacyIds` are the model IDs the legacy User-Agent sees; IDs missing from it need the hub UA.
 *
 * Entries named "<Name> (Low|Medium|High)" that share a name become one model with variants.
 * A name that appears with a single tier (e.g. "GPT-OSS 120B (Medium)") stays a plain model.
 */
export function buildRegistryModels(
  hubResponse: AvailableModelsResponse,
  legacyIds?: ReadonlySet<string>,
): RegistryModel[] {
  const groups = new Map<string, Array<{ upstreamId: string; tier?: ModelTier; info: AvailableModelInfo }>>();

  for (const upstreamId of recommendedIds(hubResponse)) {
    const info = hubResponse.models?.[upstreamId];
    if (!info) continue;
    const displayName = info.displayName?.trim() || upstreamId;
    const match = TIER_SUFFIX.exec(displayName);
    const base = match?.[1] ?? displayName;
    const tier = match?.[2]?.toLowerCase() as ModelTier | undefined;
    const members = groups.get(base) ?? [];
    members.push({ upstreamId, tier, info });
    groups.set(base, members);
  }

  const isHubOnly = (upstreamId: string) => (legacyIds ? !legacyIds.has(upstreamId) : false);
  const models: RegistryModel[] = [];

  for (const [base, members] of groups) {
    const tiered = members.length > 1 && members.every((member) => member.tier);
    const first = members[0]!;
    const info = first.info;
    const notice = [info.tagTitle, info.tagDescription].filter(Boolean).join(": ") || undefined;

    const variants: RegistryVariant[] = tiered
      ? members
          .map((member) => ({
            tier: member.tier as ModelTier,
            upstreamId: member.upstreamId,
            hubOnly: isHubOnly(member.upstreamId),
          }))
          .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
      : [];

    for (const member of tiered ? [first] : members) {
      const memberInfo = member.info;
      models.push({
        id: tiered ? slugify(base) : member.upstreamId,
        name: tiered ? base : memberInfo.displayName?.trim() || member.upstreamId,
        vendor: vendorOf(memberInfo.modelProvider, member.upstreamId),
        upstreamId: member.upstreamId,
        hubOnly: isHubOnly(member.upstreamId),
        variants,
        supportsImages: Boolean(memberInfo.supportsImages),
        supportsThinking: Boolean(memberInfo.supportsThinking),
        contextLimit: memberInfo.maxTokens ?? FALLBACK_CONTEXT,
        outputLimit: memberInfo.maxOutputTokens ?? FALLBACK_OUTPUT,
        notice,
        leavingSoon: /leaving soon|will be removed|no longer be available/i.test(notice ?? ""),
      });
    }
  }

  return models;
}

/**
 * Snapshot of Antigravity's Recommended list (hub User-Agent), taken 2026-10-13. Used until the
 * first discovery succeeds. Refresh it with `node scripts/list-models.mjs --json`.
 */
const BUILTIN_SNAPSHOT: Array<AvailableModelInfo & { id: string; hubOnly?: boolean }> = [
  { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true },
  { id: "gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true },
  { id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true },
  { id: "gemini-3.7-flash-high", displayName: "Gemini 3.7 Flash (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-3.7-flash-medium", displayName: "Gemini 3.7 Flash (Medium)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-3.7-flash-low", displayName: "Gemini 3.7 Flash (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, hubOnly: true, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-3.6-flash-high", displayName: "Gemini 3.6 Flash (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-3.6-flash-medium", displayName: "Gemini 3.6 Flash (Medium)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-3.6-flash-low", displayName: "Gemini 3.6 Flash (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, tagTitle: "Leaving Soon", tagDescription: "Start using Gemini 3.8 Flash, our best Flash model." },
  { id: "gemini-pro-agent", displayName: "Gemini 3.1 Pro (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, tagTitle: "Leaving Soon", tagDescription: "Use Gemini 3.8 Flash! As a newer model, it delivers more intelligence at 2x the speed for 70% less cost than Gemini 3.1 Pro." },
  { id: "gemini-3.1-pro-low", displayName: "Gemini 3.1 Pro (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, tagTitle: "Leaving Soon", tagDescription: "Use Gemini 3.8 Flash! As a newer model, it delivers more intelligence at 2x the speed for 70% less cost than Gemini 3.1 Pro." },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", modelProvider: "MODEL_PROVIDER_ANTHROPIC", supportsImages: true, supportsThinking: true, maxTokens: 250000, maxOutputTokens: 64000, tagTitle: "Notice", tagDescription: "Sonnet 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 2, 2026." },
  { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)", modelProvider: "MODEL_PROVIDER_ANTHROPIC", supportsImages: true, supportsThinking: true, maxTokens: 250000, maxOutputTokens: 64000, tagTitle: "Notice", tagDescription: "Opus 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 2, 2026." },
  { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", modelProvider: "MODEL_PROVIDER_OPENAI", supportsImages: false, supportsThinking: true, maxTokens: 131072, maxOutputTokens: 32768, tagTitle: "Notice", tagDescription: "GPT-OSS will be removed from Antigravity on November 2, 2026." },
];

export function builtinRegistryModels(): RegistryModel[] {
  const models: AvailableModelsResponse["models"] = {};
  const legacyIds = new Set<string>();
  for (const { id, hubOnly, ...info } of BUILTIN_SNAPSHOT) {
    models[id] = info;
    if (!hubOnly) legacyIds.add(id);
  }
  return buildRegistryModels(
    { models, agentModelSorts: [{ groups: [{ modelIds: BUILTIN_SNAPSHOT.map((entry) => entry.id) }] }] },
    legacyIds,
  );
}

// ---------------------------------------------------------------------------
// Current registry state (process-wide) and its on-disk cache
// ---------------------------------------------------------------------------

const CACHE_FILENAME = "antigravity-models.json";
const CACHE_VERSION = 1;

interface RegistryCacheFile {
  version: number;
  fetchedAt: number;
  models: RegistryModel[];
}

let current: { models: RegistryModel[]; fetchedAt?: number } | undefined;

function configDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

export function getRegistryCachePath(): string {
  return join(configDir(), CACHE_FILENAME);
}

function isRegistryModel(value: unknown): value is RegistryModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<RegistryModel>;
  return typeof model.id === "string" && typeof model.upstreamId === "string" && Array.isArray(model.variants);
}

function readCache(): { models: RegistryModel[]; fetchedAt: number } | undefined {
  const path = getRegistryCachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistryCacheFile>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.filter(isRegistryModel);
    if (models.length === 0) return undefined;
    return { models, fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0 };
  } catch (error) {
    log.warn("ignoring unreadable model cache", { path, error: String(error) });
    return undefined;
  }
}

/** The models currently offered: the last discovery (memory, then disk cache) or the snapshot. */
export function getRegistryModels(): RegistryModel[] {
  if (!current) {
    current = readCache() ?? { models: builtinRegistryModels() };
  }
  return current.models;
}

/** When the current list was discovered, or undefined for the built-in snapshot. */
export function getRegistryFetchedAt(): number | undefined {
  getRegistryModels();
  return current?.fetchedAt;
}

/** Replaces the current list with a fresh discovery and caches it on disk. */
export function setRegistryModels(models: RegistryModel[], fetchedAt = Date.now()): void {
  if (models.length === 0) return;
  current = { models, fetchedAt };
  const path = getRegistryCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, fetchedAt, models } satisfies RegistryCacheFile, null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    log.warn("could not write model cache", { path, error: String(error) });
  }
}

/** Test hook: forget the in-memory state so the next read starts over. */
export function resetRegistryForTests(models?: RegistryModel[]): void {
  current = models ? { models } : undefined;
}

// ---------------------------------------------------------------------------
// Lookups used by the request pipeline
// ---------------------------------------------------------------------------

function normalizeTier(value: string | undefined): ModelTier | undefined {
  const lower = value?.toLowerCase();
  return TIER_ORDER.find((tier) => tier === lower);
}

/**
 * Maps a requested model (catalog ID, with or without `antigravity-`, or an upstream ID) and an
 * optional tier to the upstream model ID to send. Returns undefined for models the registry does
 * not know, which keep the pipeline's own name handling.
 */
export function resolveUpstreamModel(requestedModel: string, tier?: string): UpstreamModelResolution | undefined {
  const name = requestedModel.replace(/^antigravity-/i, "").toLowerCase();
  const requestedTier = normalizeTier(tier);

  for (const model of getRegistryModels()) {
    if (model.id.toLowerCase() === name) {
      if (model.variants.length === 0) {
        return { model, upstreamId: model.upstreamId, hubOnly: model.hubOnly };
      }
      const variant =
        model.variants.find((entry) => entry.tier === requestedTier) ??
        model.variants.find((entry) => entry.upstreamId === model.upstreamId) ??
        model.variants[0]!;
      return { model, upstreamId: variant.upstreamId, tier: variant.tier, hubOnly: variant.hubOnly };
    }
    const variant = model.variants.find((entry) => entry.upstreamId.toLowerCase() === name);
    if (variant) {
      return { model, upstreamId: variant.upstreamId, tier: variant.tier, hubOnly: variant.hubOnly };
    }
    if (model.variants.length === 0 && model.upstreamId.toLowerCase() === name) {
      return { model, upstreamId: model.upstreamId, hubOnly: model.hubOnly };
    }
  }
  return undefined;
}

/** True when the upstream ID is only served to the current Antigravity client. */
export function requiresHubUserAgent(upstreamId: string): boolean {
  const lower = upstreamId.toLowerCase();
  return getRegistryModels().some(
    (model) =>
      (model.variants.length === 0 && model.hubOnly && model.upstreamId.toLowerCase() === lower) ||
      model.variants.some((variant) => variant.hubOnly && variant.upstreamId.toLowerCase() === lower),
  );
}
