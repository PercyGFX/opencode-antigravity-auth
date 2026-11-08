import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateProjectContextCache, loadManagedProject, onboardManagedProject } from "./project";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateProjectContextCache();
});

describe("loadManagedProject", () => {
  it("asks like the current Antigravity client: ideType only, hub User-Agent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ cloudaicompanionProject: "own-project" }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await loadManagedProject("token");

    expect(payload?.cloudaicompanionProject).toBe("own-project");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1internal:loadCodeAssist");
    // Cloud Code rejects "WINDOWS"/"MACOS" as platform values with a 400.
    expect(JSON.parse(init.body as string)).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toMatch(/^antigravity\/hub\//);
    expect(headers.has("Client-Metadata")).toBe(false);
  });
});

describe("onboardManagedProject", () => {
  it("sends the control plane's snake_case fields with the client version", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      json({ done: true, response: { cloudaicompanionProject: { id: "new-project" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await onboardManagedProject("token", "free-tier", undefined, 1, 0)).toBe("new-project");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      tier_id: "free-tier",
      metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.23.0", ide_name: "antigravity" },
    });
  });
});
