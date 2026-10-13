import { builtinRegistryModels, getRegistryModels, type RegistryModel } from "../model-registry";
import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

/** Thinking budgets offered as variants for Claude thinking models. */
const CLAUDE_THINKING_VARIANTS: Record<string, ModelVariant> = {
  low: { thinkingConfig: { thinkingBudget: 8192 } },
  max: { thinkingConfig: { thinkingBudget: 32768 } },
};

/**
 * Variants for a registry model: one per Antigravity tier (Low/Medium/High map to their own
 * upstream models), or thinking budgets for Claude thinking models.
 */
export function registryModelVariants(model: RegistryModel): Record<string, ModelVariant> | undefined {
  if (model.variants.length > 0) {
    return Object.fromEntries(model.variants.map((variant) => [variant.tier, { thinkingLevel: variant.tier }]));
  }
  if (model.vendor === "anthropic" && model.id.includes("thinking")) {
    return { ...CLAUDE_THINKING_VARIANTS };
  }
  return undefined;
}

/** Converts registry models to the opencode.json model shape, keyed by `antigravity-<id>`. */
export function toOpencodeModelDefinitions(models: readonly RegistryModel[]): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {};
  for (const model of models) {
    const variants = registryModelVariants(model);
    definitions[`antigravity-${model.id}`] = {
      name: `${model.name} (Antigravity)`,
      limit: { context: model.contextLimit, output: model.outputLimit },
      modalities: {
        input: model.supportsImages ? ["text", "image", "pdf"] : ["text"],
        output: ["text"],
      },
      ...(variants ? { variants } : {}),
    };
  }
  return definitions;
}

/**
 * The built-in model list (Antigravity's Recommended list at release time). OpenCode 2 uses the
 * live list instead; see `currentOpencodeModelDefinitions()`.
 */
export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = toOpencodeModelDefinitions(builtinRegistryModels());

/** The current model list: the last discovery from Antigravity, or the built-in list. */
export function currentOpencodeModelDefinitions(): OpencodeModelDefinitions {
  return toOpencodeModelDefinitions(getRegistryModels());
}
