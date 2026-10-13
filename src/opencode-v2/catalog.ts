import { Integration, Model, Provider } from "@opencode/plugin";

import { registryModelVariants, type ModelVariant } from "../plugin/config/models";
import { getRegistryModels, type RegistryModel } from "../plugin/model-registry";

/**
 * Antigravity gets its own provider and integration instead of extending `google`: opencode v2
 * keeps one active connection per integration, so an Antigravity OAuth login on `google` would
 * replace a Gemini API key for every Google model.
 */
export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
export const ANTIGRAVITY_INTEGRATION_ID = "google-antigravity";
/** Browser sign-in: the v1 callback page on localhost:51121 catches the redirect. */
export const ANTIGRAVITY_METHOD_ID = "antigravity";
/** Paste sign-in: no local server; the redirect URL is pasted back (other machine, SSH). */
export const ANTIGRAVITY_PASTE_METHOD_ID = "antigravity-paste";

/** opencode's native Gemini client; it talks the same REST shape the v1 pipeline rewrites. */
const NATIVE_GOOGLE_PACKAGE = "@opencode/ai/providers/google";

export function antigravityProviderInfo(baseURL: string): Provider.Info {
  return {
    id: Provider.ID.make(ANTIGRAVITY_PROVIDER_ID),
    integrationID: Integration.ID.make(ANTIGRAVITY_INTEGRATION_ID),
    name: "Google Antigravity",
    // Listed once the integration has a connection, i.e. after `opencode auth login`.
    activation: "auto",
    package: NATIVE_GOOGLE_PACKAGE,
    settings: { baseURL },
  };
}

/**
 * Builds the catalog from the model registry: Antigravity's Recommended list from the last
 * discovery, or the built-in snapshot. Tiered models (Low/Medium/High) become one model with
 * variants; the pipeline maps each variant to its own upstream model ID.
 *
 * Every model stays `active` even when Antigravity marks it "Leaving Soon": opencode's model
 * picker hides deprecated models, and retired models drop out of the next discovery anyway.
 */
export function antigravityModels(models: readonly RegistryModel[] = getRegistryModels()): Model.Info[] {
  const providerID = Provider.ID.make(ANTIGRAVITY_PROVIDER_ID);
  return models.map((model) => ({
    ...Model.Info.default(providerID, Model.ID.make(`antigravity-${model.id}`)),
    name: model.name,
    capabilities: {
      tools: true,
      input: model.supportsImages ? ["text", "image", "pdf"] : ["text"],
      output: ["text"],
    },
    variants: Object.entries(registryModelVariants(model) ?? {}).map(([variantID, variant]) => ({
      id: Model.VariantID.make(variantID),
      settings: variantSettings(variant),
    })),
    // Antigravity usage is quota-based, not billed per token.
    cost: [],
    limit: { context: model.contextLimit, output: model.outputLimit },
  }));
}

/**
 * v1 variants carry `thinkingLevel` or `thinkingConfig` options. opencode's native Gemini
 * client reads both from `thinkingConfig` and sends them as `generationConfig.thinkingConfig`,
 * which is where the v1 pipeline picks them up.
 */
export function variantSettings(variant: ModelVariant): Provider.Settings {
  const thinkingConfig: Record<string, unknown> = {};
  if (variant.thinkingLevel) thinkingConfig.thinkingLevel = variant.thinkingLevel;
  if (variant.thinkingConfig) thinkingConfig.thinkingBudget = variant.thinkingConfig.thinkingBudget;
  return Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {};
}
