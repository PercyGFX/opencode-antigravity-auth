# Architecture Guide

**Last Updated:** October 2026

This document explains how the Antigravity plugin works: request/response flow, Claude-specific handling, and session recovery.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode ──▶ Plugin ──▶ Antigravity API ──▶ Claude/Gemini      │
│     │           │              │                   │            │
│     │           │              │                   └─ Model     │
│     │           │              └─ Google's gateway (Gemini fmt) │
│     │           └─ THIS PLUGIN (auth, transform, recovery)      │
│     └─ AI coding assistant                                      │
└─────────────────────────────────────────────────────────────────┘
```

The plugin intercepts requests to `generativelanguage.googleapis.com`, transforms them for the Antigravity API, and handles authentication, rate limits, and error recovery.

The same request pipeline serves both OpenCode versions. Only the glue to OpenCode differs; see [OpenCode 2 Adapter](#opencode-2-adapter).

---

## Module Structure

```
index.ts                     # OpenCode 1.x entry (named v1 plugin exports)
server.ts                    # OpenCode 2 entry (default export, see below)
tui.tsx                      # OpenCode 2 TUI plugin: sidebar limits + account management
rpc.ts                       # RPC shared by server.ts and tui.tsx (quota, account actions)
src/
├── plugin.ts                # v1 plugin: hooks + fetch interceptor (shared pipeline)
├── constants.ts             # Endpoints, headers, config
├── antigravity/
│   └── oauth.ts             # OAuth token exchange
├── opencode-v2/             # OpenCode 2 adapter around the shared pipeline
│   ├── plugin.ts            # v2 setup: sign-in method, provider, proxy wiring
│   ├── proxy.ts             # Loopback proxy feeding the v1 fetch interceptor
│   ├── catalog.ts           # google-antigravity provider + models from the model registry
│   ├── quota.ts             # Per-account quota snapshot for the sidebar (RPC "quota")
│   ├── quota-format.ts      # Sidebar formatting helpers (shared with tui.tsx)
│   ├── accounts.ts          # Enable/disable/remove accounts; pool-aware login for the loader
│   ├── client-shim.ts       # Stand-in for the v1 SDK client (toasts, auth.set)
│   └── clipboard.ts         # Copies the sign-in link (no browser is opened)
│                            # (browser sign-in reuses plugin/server.ts, the 1.x callback page)
└── plugin/
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (main logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection, crash recovery
    ├── recovery.ts          # Session recovery (tool_result_missing)
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Auth & signature caching
    ├── cache/
    │   └── signature-cache.ts # Disk-based signature persistence
    ├── config/
    │   ├── schema.ts        # Zod config schema
    │   └── loader.ts        # Config file loading
    ├── accounts.ts          # Multi-account management
    ├── model-registry.ts    # Antigravity's model list -> catalog entries, upstream IDs, hub UA
    ├── model-discovery.ts   # fetchAvailableModels with the hub and the regular User-Agent
    ├── server.ts            # OAuth callback server
    └── debug.ts             # Debug logging
```

---

## Request Flow

### 1. Interception (`plugin.ts`)

```typescript
fetch() intercepted → isGenerativeLanguageRequest() → prepareAntigravityRequest()
```

- Account selection (round-robin, rate-limit aware)
- Token refresh if expired
- Endpoint fallback (daily → autopush → prod)

### 2. Request Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| Model detection | Detect Claude/Gemini from URL |
| Thinking config | Add `thinkingConfig` for thinking models |
| Thinking strip | Remove ALL thinking blocks (Claude) |
| Tool normalization | Convert to `functionDeclarations[]` |
| Schema cleaning | Remove unsupported JSON Schema fields |
| ID assignment | Assign IDs to tool calls (FIFO matching) |
| Wrap request | `{ project, model, request: {...} }` |

### 3. Response Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| SSE streaming | Real-time line-by-line TransformStream |
| Signature caching | Cache `thoughtSignature` for display |
| Format transform | `thought: true` → `type: "reasoning"` |
| Envelope unwrap | Extract inner `response` object |

---

## Claude-Specific Handling

### Why Special Handling?

Claude through Antigravity requires:
1. **Gemini format** - `contents[].parts[]` not `messages[].content[]`
2. **Thinking signatures** - Multi-turn needs signed blocks or errors
3. **Schema restrictions** - Rejects `const`, `$ref`, `$defs`, etc.
4. **Tool validation** - `VALIDATED` mode requires proper schemas

### Thinking Block Strategy (v2.0)

**Problem:** OpenCode stores thinking blocks, but may corrupt signatures.

**Solution:** Strip ALL thinking blocks from outgoing requests.

```
Turn 1 Response: { thought: true, text: "...", thoughtSignature: "abc" }
                 ↓ (stored by OpenCode, possibly corrupted)
Turn 2 Request:  Plugin STRIPS all thinking blocks
                 ↓
Claude API:      Generates fresh thinking
```

**Why this works:**
- Zero signature errors (impossible to have invalid signatures)
- Same quality (Claude sees full conversation, re-thinks fresh)
- Simpler code (no complex validation/restoration)

### Thinking Injection for Tool Use

Claude API requires thinking before `tool_use` blocks. The plugin:

1. Caches signed thinking from responses (`lastSignedThinkingBySessionKey`)
2. On subsequent requests, injects cached thinking before tool_use
3. Only injects for the **first** assistant message of a turn (not every message)

**Turn boundary detection** (`thinking-recovery.ts`):
```typescript
// A "turn" starts after a real user message (not tool_result)
// Only inject thinking into first assistant message after that
```

---

## OpenCode 2 Adapter

OpenCode 2 replaced the 1.x plugin API, and it does not run 1.x plugins. The parts this plugin relied on changed as follows:

| 1.x | 2.x |
|-----|-----|
| Plugin = exported functions returning hooks | Plugin = **default export** `{ id, setup(ctx) }` |
| `auth: { provider, loader, methods }` hook | `ctx.integration.transform()` registers OAuth methods |
| `loader` returns `{ apiKey, fetch }`; OpenCode's `@ai-sdk/google` calls that `fetch` | Google models use OpenCode's **native Gemini client**, which accepts a `baseURL` but no custom `fetch` |
| Models from `provider.google.models` in `opencode.json` | `ctx.provider.transform()` adds providers and models |
| `client` SDK object (toasts, `auth.set`, `session.*`) | No client for server plugins |
| `event` hook (`session.error`, `session.created`) | Not wired by this adapter |

`server.ts` default-exports `createAntigravityV2Plugin()` (`src/opencode-v2/plugin.ts`). OpenCode 2 loads a package's `./server` export, or a plugin folder's `server.*` file (run directly by Bun, so no build is needed). OpenCode 1.x keeps loading `index.ts`.

### Setup

```
setup(ctx)
 ├─ createAntigravityPlugin("google-antigravity")({ client: shim, directory })
 │     └─ the unchanged v1 plugin; only its auth.loader (→ fetch interceptor) is used
 ├─ startLoopbackProxy(handler)           → http://127.0.0.1:<port>/<secret>/v1beta
 ├─ integration "google-antigravity"      → OAuth "antigravity" (browser, v1 callback page)
 │                                           OAuth "antigravity-paste" (paste the redirect)
 ├─ provider "google-antigravity"         → package @opencode/ai/providers/google,
 │                                           settings.baseURL = proxy URL,
 │                                           models from the model registry
 ├─ model discovery                       → after sign-in and when the list is >6h old;
 │                                           provider.reload() rebuilds the catalog
 ├─ rpc "antigravity"                     → quota, setAccountEnabled, removeAccount (for tui.tsx)
 └─ returns cleanup                       → closes the proxy and any waiting callback listener
```

### Request Flow Under OpenCode 2

```
OpenCode native Gemini client
  POST http://127.0.0.1:<port>/<secret>/v1beta/models/<model>:streamGenerateContent?alt=sse
    │   (x-goog-api-key = OpenCode's stored access token, dropped by the proxy)
    ▼
proxy.ts  → rebuilds https://generativelanguage.googleapis.com/v1beta/models/...
          → body passed as a string (the pipeline only rewrites string bodies)
    ▼
v1 fetch interceptor (plugin.ts) — account selection, token refresh, endpoint fallback,
                                   request/response transformation, streaming
    ▼
Antigravity / Gemini CLI endpoints → SSE streamed back unchanged through the proxy
```

- **Why a proxy:** the v1 interceptor owns the whole request lifecycle (retries, rotation, fallback). OpenCode 2's `http.request`/`http.response` session hooks can only rewrite a single request and response around OpenCode's own fetch. Sitting behind `baseURL` keeps the pipeline unchanged.
- **Proxy safety:** it binds to `127.0.0.1` only, and every path must start with a random per-process secret. Other local processes therefore cannot use the signed-in accounts.
- **Own provider, not `google`:** OpenCode 2 keeps one active connection per integration. Signing in to Antigravity on `google` would make OpenCode send the OAuth token as the API key for every Google model, so this plugin uses the separate `google-antigravity` provider and integration.
- **Catalog IDs** keep the `antigravity-` prefix (`antigravity-gemini-3.8-flash`), so the v1 resolver treats them as explicit Antigravity models. Variants map to `settings.thinkingConfig` (`thinkingLevel` / `thinkingBudget`), which the native client sends as `generationConfig.thinkingConfig`; the request pipeline turns model + tier into the upstream ID (see [Model Registry](#model-registry)).

### Model Registry

`src/plugin/model-registry.ts` holds the models the plugin offers, shared by both OpenCode versions.

- **Source:** `fetchAvailableModels` called with the current Antigravity client's ("hub") User-Agent. Its `agentModelSorts` "Recommended" list, in order, becomes the registry. Models outside that list (superseded or deprecated) are left out.
- **Grouping:** entries named `<Name> (Low|Medium|High)` that share a name become one model with tier variants. Their upstream IDs need not follow a pattern (`Gemini 3.1 Pro (High)` is `gemini-pro-agent`). A name with a single tier stays a plain model (`gpt-oss-120b-medium`). Without a variant, the first-listed tier is used (Antigravity lists high first).
- **Hub-only IDs:** discovery calls the endpoint a second time with the User-Agent normal requests use. IDs missing from that answer (Gemini 3.7/3.8 Flash tiers) are flagged, and `prepareAntigravityRequest()` sends the hub User-Agent for them (`getHubUserAgent()`).
- **Routing:** `prepareAntigravityRequest()` keeps the logical model name for its transformation logic, but writes `resolveUpstreamModel(model, tier)` into the body's `model` field and aligns `thinkingLevel` with the chosen tier. Models the registry doesn't know keep the old name handling.
- **No Gemini CLI fallback for registry models:** `resolveHeaderRoutingDecision()` disables quota fallback for them. Their IDs don't exist on Gemini CLI, and accounts without a Gemini CLI license would turn a 429 into a 403. Hybrid account selection honors this too (`getCurrentOrNextForFamily(..., allowQuotaFallback)`); before, it treated a Gemini account as usable while the unused Gemini CLI pool was free, so the rotation loop spun without awaiting and froze OpenCode's service.
- **Lifecycle:** a built-in snapshot is used until the first discovery. Discoveries are cached in `~/.config/opencode/antigravity-models.json`. The v2 plugin discovers after each sign-in and whenever the list is older than 6 hours (checked at startup and on requests), then calls `ctx.provider.reload()`. All catalog models stay `active`: OpenCode's model picker hides `deprecated` ones, and models Antigravity retires drop out of the next discovery.
- **1.x:** `OPENCODE_MODEL_DEFINITIONS` (what "Configure models in opencode.json" writes) is generated from the built-in snapshot.

### Sidebar Limits and Account Management

`tui.tsx` is a TUI plugin; OpenCode loads it next to `server.ts` and compiles its Solid JSX itself, so the file ships as source. It claims `append: "sidebar.content"` and registers the `/antigravity` command. Everything that needs tokens or the pool runs on the server, behind the RPC in `rpc.ts`:

- **`quota`:** `checkAccountsQuota()` per pool account. Its `retrieveUserQuotaSummary` call (the API behind Antigravity's Settings → Models page) gives each model group's 5-hour and weekly window; if it fails, the per-model 5-hour quota from `fetchAvailableModels` is used (Gemini Pro and Flash merged). Plus which account serves each group (`activeIndexByFamily`). Cached for a minute; the TUI polls every 2 minutes and after each response.
- **`setAccountEnabled` / `removeAccount`:** go through the running pipeline's `AccountManager` (`getActiveAccountManager()`) when it exists, since it owns the pool in memory, or edit the file otherwise. Removal saves with `saveToDisk({ replace: true })`; the default save merges with the file and would bring the account back. Both methods declare a `failed` error so the TUI can show the real reason.
- **Removed accounts stay removed:** the v1 `AccountManager` always adds the account behind the credential it is given. `poolAuth()` therefore hands it OpenCode's login only while that account is still in the pool, otherwise an enabled pool account.
- **Re-authenticate / Add account** run a sign-in the plugin owns (`signInStart` / `signInStatus` / `signInComplete` / `signInCancel`, `sign-in-attempts.ts`). It reuses the browser sign-in with Google's `login_hint` set to the account, so Google preselects it, and updates only the pool: no extra opencode credential per re-authentication. The TUI shows one prompt with the link. It closes when the browser reaches the callback page (status polled every second), and a pasted redirect URL finishes the attempt too (`paste`), for when the page can't be reached (plugin reloaded, listener timed out after 9 minutes, browser on another machine). Without any account yet, Add account dispatches OpenCode's `provider.connect` (`/connect`) so opencode's login exists.

### Credentials

- **Sign-in link:** both methods copy the authorization URL to the clipboard (`clip`, `pbcopy`, `wl-copy`/`xclip`/`xsel`; skipped over SSH). The plugin never opens a browser. OpenCode's CLI opens the link itself when it runs in a terminal; the TUI dialog does not (`c` copies, `o` opens).
- **`antigravity` (browser):** starts the 1.x `startOAuthListener()` on `localhost:51121` (the redirect URI is fixed by the OAuth client) and returns `mode: "auto"`. Its `callback` promise resolves once the browser hits the listener, which serves the "All set!" page. The listener has a 5-minute timeout, under OpenCode's 10-minute attempt limit. It closes on success, failure, timeout and plugin cleanup, and a new attempt replaces an abandoned one. The method falls back to the paste flow when `shouldSkipLocalServer()` is true (WSL2 or remote) or the port is busy.
- **`antigravity-paste`:** returns `mode: "code"` and accepts the pasted redirect URL or a bare code (the state comes from the authorization URL).
- **Finish:** both methods exchange the code, add the account to `antigravity-accounts.json` (`persistAccountPool`), and return a `Credential.OAuth` carrying their method ID.
- **Refresh:** OpenCode calls `refresh` when the stored token is within 5 minutes of expiry. It reuses `refreshAccessToken()`.
- **Pipeline auth:** `getAuth()` resolves the active `google-antigravity` connection into the v1 `{ type: "oauth", refresh, access, expires }` shape. The v1 loader runs lazily on the first request. It runs again when the signed-in refresh token changes or a sign-in adds an account.
- **Guard:** the v1 loader clears the account pool when it sees no OAuth credential. The adapter therefore never calls it without one, and answers `401 Not signed in` instead.

### What the Client Shim Covers

`client-shim.ts` gives the v1 code a stand-in client:

- **Toasts:** `tui.showToast` only logs.
- **Stored credential:** `auth.set` (clearing the stored credential after all accounts are revoked) is a no-op. The next request fails with a sign-in hint instead.
- **Session calls:** `session.*` throws. Those calls are only reached from event-driven session recovery, which is not wired under OpenCode 2.

### Not Yet Ported

- **Session recovery:** recovery of interrupted tool calls (`session.error` → inject `tool_result`) and `auto_resume`. Thinking-block recovery inside the request pipeline still works.
- **`google_search` tool:** OpenCode 2's tool API needs Effect Schema input definitions.
- **Toasts and TUI log output** from the request pipeline. (Account management and quota have their own TUI plugin instead of the 1.x terminal menu.)

---

## Session Recovery

> **OpenCode 2:** the event-driven recovery below is not wired yet (see [Not Yet Ported](#not-yet-ported)). Thinking Block Order recovery happens inside the request pipeline and works on both versions.

### Tool Result Missing Error

When a tool execution is interrupted (ESC, timeout, crash):

```
Error: tool_use ids were found without tool_result blocks immediately after
```

**Recovery flow** (`recovery.ts`):

1. Detect error via `session.error` event
2. Fetch session messages via `client.session.messages()`
3. Extract `tool_use` IDs from failed message
4. Inject synthetic `tool_result` blocks:
   ```typescript
   { type: "tool_result", tool_use_id: id, content: "Operation cancelled" }
   ```
5. Send via `client.session.prompt()`
6. Optionally auto-resume with "continue"

### Thinking Block Order Error

```
Error: Expected thinking but found text
```

**Recovery** (`thinking-recovery.ts`):

1. Detect conversation is in tool loop without thinking at turn start
2. Close the corrupted turn with synthetic messages
3. Start fresh turn where Claude can generate new thinking

---

## Schema Cleaning

Claude rejects unsupported JSON Schema features. The plugin uses an **allowlist approach**:

**Kept:** `type`, `properties`, `required`, `description`, `enum`, `items`

**Removed:** `const`, `$ref`, `$defs`, `default`, `examples`, `additionalProperties`, `$schema`, `title`

**Transformations:**
- `const: "value"` → `enum: ["value"]`
- Empty object schema → Add placeholder `reason` property

---

## Multi-Account Load Balancing

### How It Works

1. **Sticky selection** - Same account until rate limited (preserves cache)
2. **Per-model-family** - Claude/Gemini rate limits tracked separately
3. **Dual quota (Gemini)** - Antigravity + Gemini CLI headers
4. **Automatic failover** - On 429, switch to next available account

### Account Storage

Location: `~/.config/opencode/antigravity-accounts.json`

Contains OAuth refresh tokens - treat as sensitive.

---

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | `1` or `2` for file debug logging |
| `OPENCODE_ANTIGRAVITY_DEBUG_TUI` | `1` or `true` for TUI log panel debug output |
| `OPENCODE_ANTIGRAVITY_QUIET` | Suppress toast notifications |

`debug` and `debug_tui` are independent sinks: `debug` controls file logs, while `debug_tui` controls TUI logs.

### Config File

Location: `~/.config/opencode/antigravity.json`

```json
{
  "session_recovery": true,
  "auto_resume": true,
  "resume_text": "continue",
  "keep_thinking": false
}
```

---

## Key Functions Reference

### `request.ts`

| Function | Purpose |
|----------|---------|
| `prepareAntigravityRequest()` | Main request transformation |
| `transformAntigravityResponse()` | SSE streaming, format conversion |
| `ensureThinkingBeforeToolUseInContents()` | Inject cached thinking |
| `createStreamingTransformer()` | Real-time SSE processing |

### `request-helpers.ts`

| Function | Purpose |
|----------|---------|
| `deepFilterThinkingBlocks()` | Recursive thinking block removal |
| `cleanJSONSchemaForAntigravity()` | Schema sanitization |
| `transformThinkingParts()` | `thought` → `reasoning` format |

### `thinking-recovery.ts`

| Function | Purpose |
|----------|---------|
| `analyzeConversationState()` | Detect turn boundaries, tool loops |
| `needsThinkingRecovery()` | Check if recovery needed |
| `closeToolLoopForThinking()` | Inject synthetic messages |

### `recovery.ts`

| Function | Purpose |
|----------|---------|
| `handleSessionRecovery()` | Main recovery orchestration |
| `createSessionRecoveryHook()` | Hook factory for plugin |

---

## Debugging

### Enable Logging

```bash
export OPENCODE_ANTIGRAVITY_DEBUG=2      # Verbose file logs
export OPENCODE_ANTIGRAVITY_DEBUG_TUI=1  # TUI log panel output
```

### Log Location

`~/.config/opencode/antigravity-logs/`

On OpenCode 2, plugin load failures (`failed to load plugin`) go to the OpenCode server log at `~/.local/share/opencode/log/opencode.log`. `opencode plugin list` shows whether the plugin loaded.

### What To Check

1. Is `isClaudeModel` true for Claude models?
2. Are thinking blocks being stripped?
3. Are tool schemas being cleaned?
4. Is session recovery triggering?

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid signature` | Corrupted thinking block | Update plugin (strips all thinking) |
| `Unknown field: const` | Schema uses `const` | Plugin auto-converts to `enum` |
| `tool_use without tool_result` | Interrupted execution | Session recovery injects results |
| `Expected thinking but found text` | Turn started without thinking | Thinking recovery closes turn |
| `429 Too Many Requests` | Rate limited | Plugin auto-rotates accounts |

---

## See Also

- [ANTIGRAVITY_API_SPEC.md](./ANTIGRAVITY_API_SPEC.md) - API reference
- [README.md](../README.md) - Installation & usage
