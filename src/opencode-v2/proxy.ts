import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createLogger } from "../plugin/logger";

const log = createLogger("opencode-v2.proxy");

/** The host the v1 request pipeline recognises and rewrites to Antigravity. */
export const UPSTREAM_ORIGIN = "https://generativelanguage.googleapis.com";

/** Request headers that describe the loopback hop rather than the upstream request. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
  // opencode sends the OAuth access token here; the pipeline authenticates per account instead.
  "x-goog-api-key",
  "authorization",
]);

/** `fetch()` already decoded the body, so these no longer describe what we write back. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
]);

export type ProxyHandler = (url: string, init: RequestInit) => Promise<Response>;

export interface LoopbackProxy {
  /** Gemini-style base URL (`.../v1beta`) to hand to opencode's native Google client. */
  readonly baseURL: string;
  close(): Promise<void>;
}

/** Error the handler can throw to control the HTTP status of the reply. */
export class ProxyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProxyRequestError";
  }
}

/**
 * opencode v2 drives Google models through its own native client, which takes a `baseURL` but no
 * custom `fetch`. This loopback server sits behind that `baseURL` and hands each request to the
 * v1 `fetch(url, init)` pipeline as if it were addressed to generativelanguage.googleapis.com.
 *
 * It listens on 127.0.0.1 only, and every path must start with a random per-process secret so
 * other local processes cannot spend the signed-in accounts' quota.
 */
export async function startLoopbackProxy(handler: ProxyHandler): Promise<LoopbackProxy> {
  const secret = randomBytes(24).toString("hex");
  const prefix = `/${secret}`;

  const server = createServer((req, res) => {
    void handle(req, res, prefix, handler);
  });
  // Streaming completions can stay open for many minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();

  const { port } = server.address() as AddressInfo;
  log.debug("listening", { port });

  return {
    baseURL: `http://127.0.0.1:${port}${prefix}/v1beta`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  prefix: string,
  handler: ProxyHandler,
): Promise<void> {
  const path = req.url ?? "/";
  if (!path.startsWith(`${prefix}/`)) {
    sendError(res, 404, "Not found");
    return;
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  try {
    const body = await readBody(req);
    const response = await handler(`${UPSTREAM_ORIGIN}${path.slice(prefix.length)}`, {
      method: req.method ?? "POST",
      headers: forwardHeaders(req),
      // The v1 pipeline only rewrites string bodies (Gemini requests are always JSON).
      body: body.length > 0 ? body.toString("utf8") : undefined,
      signal: abort.signal,
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });
    res.writeHead(response.status, headers);

    if (!response.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
    stream.on("error", (error) => {
      log.warn("upstream stream failed", { error: String(error) });
      res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    if (abort.signal.aborted) {
      res.destroy();
      return;
    }
    const status = error instanceof ProxyRequestError ? error.status : 502;
    const message = error instanceof Error ? error.message : String(error);
    log.warn("request failed", { status, error: message });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, status, message);
  }
}

function forwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/** Replies in the Gemini API error shape so opencode surfaces the message to the user. */
function sendError(res: ServerResponse, status: number, message: string): void {
  const payload = JSON.stringify({
    error: { code: status, message, status: status === 401 ? "UNAUTHENTICATED" : "UNAVAILABLE" },
  });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
