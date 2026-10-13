import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

import {
  buildRegistryModels,
  builtinRegistryModels,
  getRegistryCachePath,
  getRegistryFetchedAt,
  getRegistryModels,
  requiresHubUserAgent,
  resetRegistryForTests,
  resolveUpstreamModel,
  setRegistryModels,
  type AvailableModelsResponse,
} from "./model-registry";
import { prepareAntigravityRequest } from "./request";

const gemini = (displayName: string, extra: Record<string, unknown> = {}) => ({
  displayName,
  modelProvider: "MODEL_PROVIDER_GOOGLE",
  supportsImages: true,
  supportsThinking: true,
  maxTokens: 1048576,
  maxOutputTokens: 65536,
  ...extra,
});

/** Trimmed `fetchAvailableModels` response (hub User-Agent), shaped like the live one. */
const HUB_RESPONSE: AvailableModelsResponse = {
  models: {
    "gemini-3.8-flash-high": gemini("Gemini 3.8 Flash (High)"),
    "gemini-3.8-flash-medium": gemini("Gemini 3.8 Flash (Medium)"),
    "gemini-3.8-flash-low": gemini("Gemini 3.8 Flash (Low)"),
    "gemini-pro-agent": gemini("Gemini 3.1 Pro (High)", { tagTitle: "Leaving Soon", tagDescription: "Use Gemini 3.8 Flash!" }),
    "gemini-3.1-pro-low": gemini("Gemini 3.1 Pro (Low)", { tagTitle: "Leaving Soon", tagDescription: "Use Gemini 3.8 Flash!" }),
    "gemini-3.1-pro-high": gemini("Gemini 3.1 Pro (High)"),
    "gemini-3-flash": gemini("Gemini 3 Flash"),
    "claude-opus-4-6-thinking": {
      displayName: "Claude Opus 4.6 (Thinking)",
      modelProvider: "MODEL_PROVIDER_ANTHROPIC",
      supportsImages: true,
      supportsThinking: true,
      maxTokens: 250000,
      maxOutputTokens: 64000,
    },
    "gpt-oss-120b-medium": {
      displayName: "GPT-OSS 120B (Medium)",
      modelProvider: "MODEL_PROVIDER_OPENAI",
      supportsThinking: true,
      maxTokens: 131072,
      maxOutputTokens: 32768,
    },
  },
  agentModelSorts: [
    {
      groups: [
        {
          modelIds: [
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "gemini-3.8-flash-low",
            "gemini-pro-agent",
            "gemini-3.1-pro-low",
            "claude-opus-4-6-thinking",
            "gpt-oss-120b-medium",
          ],
        },
      ],
    },
  ],
};

/** IDs the legacy User-Agent sees: 3.8 Flash is hub-only. */
const LEGACY_IDS = new Set(["gemini-pro-agent", "gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-3-flash", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);

describe("buildRegistryModels", () => {
  const models = buildRegistryModels(HUB_RESPONSE, LEGACY_IDS);
  const find = (id: string) => models.find((model) => model.id === id);

  it("keeps only Antigravity's Recommended list, in its order", () => {
    expect(models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.1-pro",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    // Listed by fetchAvailableModels but not recommended (old or deprecated).
    expect(find("gemini-3-flash")).toBeUndefined();
  });

  it("groups Low/Medium/High entries into one model with tier variants", () => {
    expect(find("gemini-3.8-flash")).toMatchObject({
      name: "Gemini 3.8 Flash",
      vendor: "google",
      upstreamId: "gemini-3.8-flash-high",
      variants: [
        { tier: "low", upstreamId: "gemini-3.8-flash-low", hubOnly: true },
        { tier: "medium", upstreamId: "gemini-3.8-flash-medium", hubOnly: true },
        { tier: "high", upstreamId: "gemini-3.8-flash-high", hubOnly: true },
      ],
      contextLimit: 1048576,
      outputLimit: 65536,
    });
  });

  it("groups by display name, so differently named tier IDs still pair up", () => {
    expect(find("gemini-3.1-pro")?.variants).toEqual([
      { tier: "low", upstreamId: "gemini-3.1-pro-low", hubOnly: false },
      { tier: "high", upstreamId: "gemini-pro-agent", hubOnly: false },
    ]);
    expect(find("gemini-3.1-pro")).toMatchObject({ leavingSoon: true, notice: "Leaving Soon: Use Gemini 3.8 Flash!" });
  });

  it("keeps a name with a single tier as a plain model", () => {
    expect(find("gpt-oss-120b-medium")).toMatchObject({
      name: "GPT-OSS 120B (Medium)",
      vendor: "openai",
      upstreamId: "gpt-oss-120b-medium",
      variants: [],
      supportsImages: false,
    });
  });

  it("picks up a brand-new model with no code changes", () => {
    const future = buildRegistryModels(
      {
        models: {
          "gemini-3.9-flash-high": gemini("Gemini 3.9 Flash (High)"),
          "gemini-3.9-flash-low": gemini("Gemini 3.9 Flash (Low)"),
          "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5", modelProvider: "MODEL_PROVIDER_ANTHROPIC", maxTokens: 500000, maxOutputTokens: 64000 },
        },
        agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.9-flash-high", "gemini-3.9-flash-low", "claude-sonnet-5-5"] }] }],
      },
      new Set(["claude-sonnet-5-5"]),
    );
    expect(future.map((model) => [model.id, model.upstreamId, model.variants.length])).toEqual([
      ["gemini-3.9-flash", "gemini-3.9-flash-high", 2],
      ["claude-sonnet-5-5", "claude-sonnet-5-5", 0],
    ]);
  });
});

describe("builtinRegistryModels", () => {
  it("covers the models Antigravity recommended at release", () => {
    expect(builtinRegistryModels().map((model) => model.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
  });
});

describe("registry lookups", () => {
  beforeEach(() => resetRegistryForTests(buildRegistryModels(HUB_RESPONSE, LEGACY_IDS)));
  afterEach(() => resetRegistryForTests());

  it("maps a catalog model and tier to the upstream model", () => {
    expect(resolveUpstreamModel("antigravity-gemini-3.8-flash", "low")).toMatchObject({
      upstreamId: "gemini-3.8-flash-low",
      tier: "low",
      hubOnly: true,
    });
    expect(resolveUpstreamModel("gemini-3.1-pro", "HIGH")).toMatchObject({ upstreamId: "gemini-pro-agent", tier: "high" });
  });

  it("uses Antigravity's first-listed tier when none is requested or the tier is unknown", () => {
    expect(resolveUpstreamModel("antigravity-gemini-3.8-flash")).toMatchObject({ upstreamId: "gemini-3.8-flash-high", tier: "high" });
    expect(resolveUpstreamModel("antigravity-gemini-3.1-pro", "minimal")).toMatchObject({ upstreamId: "gemini-pro-agent" });
  });

  it("accepts upstream IDs directly", () => {
    expect(resolveUpstreamModel("gemini-3.8-flash-medium")).toMatchObject({ upstreamId: "gemini-3.8-flash-medium", tier: "medium" });
    expect(resolveUpstreamModel("antigravity-claude-opus-4-6-thinking")).toMatchObject({ upstreamId: "claude-opus-4-6-thinking" });
  });

  it("returns undefined for models it does not know", () => {
    expect(resolveUpstreamModel("antigravity-gemini-3-pro")).toBeUndefined();
    expect(resolveUpstreamModel("gemini-2.5-flash")).toBeUndefined();
  });

  it("knows which upstream IDs need the hub User-Agent", () => {
    expect(requiresHubUserAgent("gemini-3.8-flash-high")).toBe(true);
    expect(requiresHubUserAgent("gemini-pro-agent")).toBe(false);
    expect(requiresHubUserAgent("unknown-model")).toBe(false);
  });
});

describe("registry cache", () => {
  let dir: string;
  const original = process.env.OPENCODE_CONFIG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antigravity-registry-"));
    process.env.OPENCODE_CONFIG_DIR = dir;
    resetRegistryForTests();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = original;
    resetRegistryForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the built-in list when nothing was discovered yet", () => {
    expect(getRegistryModels().map((model) => model.id)).toEqual(builtinRegistryModels().map((model) => model.id));
    expect(getRegistryFetchedAt()).toBeUndefined();
  });

  it("persists a discovery and reloads it on the next start", () => {
    const discovered = buildRegistryModels(HUB_RESPONSE, LEGACY_IDS);
    setRegistryModels(discovered, 1_700_000_000_000);
    expect(getRegistryCachePath()).toBe(join(dir, "antigravity-models.json"));

    resetRegistryForTests();
    expect(getRegistryModels().map((model) => model.id)).toEqual(discovered.map((model) => model.id));
    expect(getRegistryFetchedAt()).toBe(1_700_000_000_000);
  });

  it("ignores an unreadable cache", () => {
    writeFileSync(join(dir, "antigravity-models.json"), "{ not json");
    expect(getRegistryModels().map((model) => model.id)).toEqual(builtinRegistryModels().map((model) => model.id));
  });

  it("never replaces the list with an empty discovery", () => {
    setRegistryModels([]);
    expect(getRegistryModels().length).toBeGreaterThan(0);
  });
});

describe("prepareAntigravityRequest with registry models", () => {
  beforeEach(() => resetRegistryForTests(buildRegistryModels(HUB_RESPONSE, LEGACY_IDS)));
  afterEach(() => resetRegistryForTests());

  const prepare = (model: string, generationConfig?: Record<string, unknown>) => {
    const result = prepareAntigravityRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], ...(generationConfig ? { generationConfig } : {}) }),
      },
      "access-token",
      "project-1",
    );
    const body = JSON.parse(result.init.body as string) as {
      model: string;
      request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } };
    };
    return { body, userAgent: (result.init.headers as Headers).get("User-Agent") ?? "" };
  };

  it("sends the tier's upstream model, its thinking level and the hub User-Agent", () => {
    const { body, userAgent } = prepare("antigravity-gemini-3.8-flash", { thinkingConfig: { thinkingLevel: "low" } });
    expect(body.model).toBe("gemini-3.8-flash-low");
    expect(body.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
    expect(userAgent).toContain("antigravity/hub/");
  });

  it("uses Antigravity's default tier without a variant", () => {
    const { body } = prepare("antigravity-gemini-3.8-flash");
    expect(body.model).toBe("gemini-3.8-flash-high");
    expect(body.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  it("routes Gemini 3.1 Pro High to its renamed upstream model without the hub User-Agent", () => {
    const { body, userAgent } = prepare("antigravity-gemini-3.1-pro", { thinkingConfig: { thinkingLevel: "high" } });
    expect(body.model).toBe("gemini-pro-agent");
    expect(userAgent).not.toContain("antigravity/hub/");
  });

  it("leaves models outside the registry to the existing name handling", () => {
    const { body, userAgent } = prepare("antigravity-gemini-3-pro");
    expect(body.model).toBe("gemini-3-pro-low");
    expect(userAgent).not.toContain("antigravity/hub/");
  });
});
