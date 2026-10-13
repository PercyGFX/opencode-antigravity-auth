import { describe, expect, it, vi } from "vitest";

import { discoverRegistryModels } from "./model-discovery";

const model = (displayName: string) => ({
  displayName,
  modelProvider: "MODEL_PROVIDER_GOOGLE",
  supportsImages: true,
  supportsThinking: true,
  maxTokens: 1048576,
  maxOutputTokens: 65536,
});

const hubBody = {
  models: {
    "gemini-3.8-flash-high": model("Gemini 3.8 Flash (High)"),
    "gemini-3.8-flash-low": model("Gemini 3.8 Flash (Low)"),
    "gemini-3.1-pro-low": model("Gemini 3.1 Pro (Low)"),
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.1-pro-low"] }] }],
};
const legacyBody = { models: { "gemini-3.1-pro-low": model("Gemini 3.1 Pro (Low)") } };

const fetchByUserAgent = (status = 200) =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const userAgent = new Headers(init.headers).get("User-Agent") ?? "";
    const body = userAgent.includes("antigravity/hub/") ? hubBody : legacyBody;
    return new Response(JSON.stringify(body), { status });
  });

describe("discoverRegistryModels", () => {
  it("builds the registry from the hub list and flags IDs the request User-Agent cannot see", async () => {
    const fetchImpl = fetchByUserAgent();
    const models = await discoverRegistryModels("token", "project-1", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(JSON.parse(init.body as string)).toEqual({ project: "project-1" });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");

    expect(models.map((entry) => entry.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro-low"]);
    expect(models[0]!.variants.every((variant) => variant.hubOnly)).toBe(true);
    expect(models[1]!.hubOnly).toBe(false);
  });

  it("throws when Antigravity answers with an error, so the current list is kept", async () => {
    await expect(discoverRegistryModels("token", "", fetchByUserAgent(403))).rejects.toThrow("fetchAvailableModels 403");
  });

  it("throws when the recommended list is empty", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: {} })));
    await expect(discoverRegistryModels("token", "", fetchImpl)).rejects.toThrow("no recommended models");
  });
});
