import { describe, expect, it } from "vitest";

import { builtinRegistryModels } from "../plugin/model-registry";
import {
  ANTIGRAVITY_INTEGRATION_ID,
  ANTIGRAVITY_PROVIDER_ID,
  antigravityModels,
  antigravityProviderInfo,
  variantSettings,
} from "./catalog";

describe("antigravityProviderInfo", () => {
  it("routes the native Google client through the given base URL", () => {
    const info = antigravityProviderInfo("http://127.0.0.1:1234/secret/v1beta");
    expect(info).toMatchObject({
      id: ANTIGRAVITY_PROVIDER_ID,
      integrationID: ANTIGRAVITY_INTEGRATION_ID,
      activation: "auto",
      package: "@opencode/ai/providers/google",
      settings: { baseURL: "http://127.0.0.1:1234/secret/v1beta" },
    });
  });
});

describe("antigravityModels", () => {
  const models = antigravityModels(builtinRegistryModels());
  const find = (id: string) => models.find((model) => model.id === id);

  it("lists every registry model under its antigravity- ID, as both catalog and API ID", () => {
    expect(models.map((model) => model.id)).toEqual(
      builtinRegistryModels().map((model) => `antigravity-${model.id}`),
    );
    for (const model of models) {
      expect(model.modelID).toBe(model.id);
      expect(model.providerID).toBe(ANTIGRAVITY_PROVIDER_ID);
    }
  });

  it("takes names, limits and modalities from Antigravity's metadata", () => {
    expect(find("antigravity-gemini-3.8-flash")).toMatchObject({
      name: "Gemini 3.8 Flash",
      limit: { context: 1048576, output: 65536 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      cost: [],
    });
    expect(find("antigravity-gpt-oss-120b-medium")).toMatchObject({
      name: "GPT-OSS 120B (Medium)",
      limit: { context: 131072, output: 32768 },
      capabilities: { input: ["text"] },
    });
  });

  it("keeps models Antigravity marks as leaving soon visible", () => {
    // opencode's model picker hides `deprecated` models.
    for (const model of models) {
      expect(model.status).toBe("active");
    }
  });

  it("turns Antigravity tiers into thinkingLevel variants", () => {
    expect(find("antigravity-gemini-3.8-flash")?.variants).toEqual([
      { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } } },
      { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } } },
      { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } },
    ]);
  });

  it("maps Claude thinking budgets into thinkingConfig settings", () => {
    expect(find("antigravity-claude-opus-4-6-thinking")?.variants).toEqual([
      { id: "low", settings: { thinkingConfig: { thinkingBudget: 8192 } } },
      { id: "max", settings: { thinkingConfig: { thinkingBudget: 32768 } } },
    ]);
  });

  it("gives single-ID models without tiers no variants", () => {
    expect(find("antigravity-claude-sonnet-4-6")?.variants).toEqual([]);
    expect(find("antigravity-gpt-oss-120b-medium")?.variants).toEqual([]);
  });
});

describe("variantSettings", () => {
  it("returns empty settings for an empty variant", () => {
    expect(variantSettings({})).toEqual({});
  });
});
