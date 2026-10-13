import { describe, expect, it } from "vitest";

import { builtinRegistryModels } from "../model-registry";
import { OPENCODE_MODEL_DEFINITIONS, registryModelVariants, toOpencodeModelDefinitions } from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("lists Antigravity's recommended models from the built-in snapshot", () => {
    expect(Object.keys(OPENCODE_MODEL_DEFINITIONS)).toEqual([
      "antigravity-gemini-3.8-flash",
      "antigravity-gemini-3.7-flash",
      "antigravity-gemini-3.6-flash",
      "antigravity-gemini-3.1-pro",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-gpt-oss-120b-medium",
    ]);
  });

  it("drops retired models", () => {
    for (const retired of [
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3-flash",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-pro-preview",
    ]) {
      expect(OPENCODE_MODEL_DEFINITIONS[retired]).toBeUndefined();
    }
  });

  it("offers each Antigravity tier as a thinkingLevel variant", () => {
    expect(getModel("antigravity-gemini-3.8-flash").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });

  it("gives single-ID models without tiers no variants", () => {
    expect(getModel("antigravity-claude-sonnet-4-6").variants).toBeUndefined();
    expect(getModel("antigravity-gpt-oss-120b-medium").variants).toBeUndefined();
  });

  it("takes names, limits and modalities from Antigravity's metadata", () => {
    expect(getModel("antigravity-gemini-3.8-flash")).toMatchObject({
      name: "Gemini 3.8 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(getModel("antigravity-gpt-oss-120b-medium")).toMatchObject({
      limit: { context: 131072, output: 32768 },
      modalities: { input: ["text"], output: ["text"] },
    });
  });
});

describe("toOpencodeModelDefinitions", () => {
  it("matches the registry model by model", () => {
    const models = builtinRegistryModels();
    const definitions = toOpencodeModelDefinitions(models);
    expect(Object.keys(definitions)).toHaveLength(models.length);
    expect(registryModelVariants(models.find((model) => model.id === "gpt-oss-120b-medium")!)).toBeUndefined();
  });
});
