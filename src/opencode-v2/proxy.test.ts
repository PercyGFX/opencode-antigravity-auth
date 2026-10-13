import { afterEach, describe, expect, it, vi } from "vitest";

import { ProxyRequestError, startLoopbackProxy, type LoopbackProxy, type ProxyHandler } from "./proxy";

let proxy: LoopbackProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

const start = async (handler: ProxyHandler) => {
  proxy = await startLoopbackProxy(handler);
  return proxy;
};

describe("startLoopbackProxy", () => {
  it("exposes a loopback Gemini base URL behind a random secret", async () => {
    const { baseURL } = await start(async () => new Response("{}"));
    expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/v1beta$/);
  });

  it("forwards requests as generativelanguage.googleapis.com calls with a string body", async () => {
    const handler = vi.fn<ProxyHandler>(async () => new Response('{"ok":true}', { status: 200 }));
    const { baseURL } = await start(handler);
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

    const response = await fetch(`${baseURL}/models/antigravity-gemini-3-flash:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "oauth-access-token",
        "x-custom": "kept",
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const [url, init] = handler.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent?alt=sse",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("kept");
    expect(headers.has("x-goog-api-key")).toBe(false);
    expect(headers.has("host")).toBe(false);
  });

  it("streams the upstream body through unchanged", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'];
    const { baseURL } = await start(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await fetch(`${baseURL}/models/m:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(chunks.join(""));
  });

  it("passes upstream error statuses through", async () => {
    const { baseURL } = await start(async () => new Response('{"error":{"code":429}}', { status: 429 }));
    const response = await fetch(`${baseURL}/models/m:streamGenerateContent`, { method: "POST", body: "{}" });
    expect(response.status).toBe(429);
  });

  it("rejects paths without the secret and never calls the handler", async () => {
    const handler = vi.fn<ProxyHandler>(async () => new Response("{}"));
    const { baseURL } = await start(handler);
    const origin = new URL(baseURL).origin;

    const response = await fetch(`${origin}/v1beta/models/m:streamGenerateContent`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps ProxyRequestError to its status with a Gemini-style error body", async () => {
    const { baseURL } = await start(async () => {
      throw new ProxyRequestError("Not signed in", 401);
    });
    const response = await fetch(`${baseURL}/models/m:streamGenerateContent`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 401, message: "Not signed in", status: "UNAUTHENTICATED" },
    });
  });

  it("maps unexpected handler errors to 502", async () => {
    const { baseURL } = await start(async () => {
      throw new Error("All Antigravity accounts failed");
    });
    const response = await fetch(`${baseURL}/models/m:streamGenerateContent`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("All Antigravity accounts failed");
  });
});
